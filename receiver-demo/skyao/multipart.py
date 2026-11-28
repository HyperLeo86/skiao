"""Bounded streaming intake to receiver-owned staging files."""

import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path

from python_multipart import MultipartParser
from python_multipart.exceptions import MultipartParseError
from werkzeug.exceptions import ClientDisconnected

from .protocol import CHUNK, Problem, file_name


@dataclass(frozen=True)
class Limits:
    file: int
    total: int
    manifest: int
    files: int

    @property
    def request(self):
        return self.total + self.manifest + (self.files + 1) * 16384


@dataclass(frozen=True)
class Upload:
    path: Path
    size: int
    sha256: str


def bad_form(message):
    return Problem(400, "INVALID_MULTIPART", message)


def too_large(message):
    return Problem(413, "UPLOAD_LIMIT", message)


def disposition(raw):
    # The protocol's names are ASCII tokens. Keep the original filename so
    # Windows paths and escaped slashes cannot be normalized into basenames.
    parts = raw.split(b";")
    if parts[0].strip().lower() != b"form-data":
        raise bad_form("Expected form-data disposition.")
    values = {}
    for part in parts[1:]:
        key, found, value = part.strip().partition(b"=")
        if not found or key not in {b"name", b"filename"} or key in values:
            raise bad_form("Unexpected or duplicate disposition parameter.")
        if value.startswith(b'"') and value.endswith(b'"') and len(value) >= 2:
            value = value[1:-1]
        values[key] = value
    return values


class StagingForm:
    def __init__(self, directory, limits, filename):
        self.directory = directory
        self.limits = limits
        self.filename = filename
        self.manifest = None
        self.files = {}
        self.total = 0
        self.closed = False
        self.output = None

    def on_part_begin(self):
        self.header_key = bytearray()
        self.header_value = bytearray()
        self.headers = {}
        self.name = None

    def on_header_field(self, data, start, end):
        self.header_key.extend(data[start:end])

    def on_header_value(self, data, start, end):
        self.header_value.extend(data[start:end])

    def on_header_end(self):
        key = bytes(self.header_key).lower()
        if key in self.headers:
            raise bad_form("Duplicate part header.")
        self.headers[key] = bytes(self.header_value)
        self.header_key.clear()
        self.header_value.clear()

    def on_headers_finished(self):
        parts = disposition(self.headers.get(b"content-disposition", b""))
        if parts == {b"name": b"manifest"} and self.manifest is None:
            self.manifest = bytearray()
            return
        if parts.get(b"name") != b"files" or b"filename" not in parts:
            raise bad_form("Expected one manifest text field and files parts.")
        self.name = self.filename(parts[b"filename"])
        if self.name in self.files:
            raise bad_form("Duplicate multipart filename.")
        if len(self.files) >= self.limits.files:
            raise too_large("Too many uploaded files.")
        self.path = self.directory / str(len(self.files))
        self.output = self.path.open("xb")
        self.count = 0
        self.digest = hashlib.sha256()

    def on_part_data(self, data, start, end):
        chunk = data[start:end]
        if self.name is None:
            if len(self.manifest) + len(chunk) > self.limits.manifest:
                raise too_large("Manifest exceeds the size limit.")
            self.manifest.extend(chunk)
            return
        self.count += len(chunk)
        self.total += len(chunk)
        if self.count > self.limits.file or self.total > self.limits.total:
            raise too_large("File or total file size exceeds the upload limit.")
        self.digest.update(chunk)
        self.output.write(chunk)

    def on_part_end(self):
        if self.name is not None:
            self.output.flush()
            os.fsync(self.output.fileno())
            self.output.close()
            self.output = None
            self.files[self.name] = Upload(self.path, self.count, self.digest.hexdigest())

    def on_end(self):
        self.closed = True


def legacy_filename(raw):
    return file_name(raw.decode("latin-1"), "multipart filename")


def stage_request(request, directory, limits, *, filename=legacy_filename):
    boundary = request.mimetype_params.get("boundary", "")
    if request.mimetype != "multipart/form-data" or not re.fullmatch(r"[0-9A-Za-z'()+_,./:=? -]{1,70}", boundary):
        raise bad_form("Expected multipart/form-data with a valid boundary.")
    if request.content_length is not None and request.content_length > limits.request:
        raise too_large("Request body exceeds the upload limit.")
    form = StagingForm(directory, limits, filename)
    parser = MultipartParser(boundary, {
        name: getattr(form, name) for name in dir(form) if name.startswith("on_")
    })
    try:
        total = 0
        for chunk in iter(lambda: request.stream.read(CHUNK), b""):
            total += len(chunk)
            if total > limits.request:
                raise too_large("Request body exceeds the upload limit.")
            parser.write(chunk)
    except (MultipartParseError, ClientDisconnected):
        raise bad_form("Malformed or incomplete multipart body.") from None
    finally:
        if form.output is not None:
            form.output.close()
    if not form.closed or not form.manifest or not form.files:
        raise bad_form("Expected a complete manifest and at least one uploaded file.")
    return bytes(form.manifest), form.files
