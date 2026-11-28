"""The HTTPS rehearsal exposes only browser-owned projects and files."""

from tempfile import TemporaryDirectory
from unittest import TestCase

from skyao.server import DEFAULT_SEED, create_app


class ShareIsolationTest(TestCase):
    def test_isolates_browser_projects_and_hides_demo_session(self):
        origin = "https://preview.example.org"
        api = "/demo/rehearsal/api/projects"
        with TemporaryDirectory() as directory:
            app = create_app(directory, DEFAULT_SEED, "test-token", demo=True, share_origin=origin)
            browser = app.test_client()
            outsider = app.test_client()
            self.assertEqual(outsider.post(api, base_url=origin, json={}).status_code, 403)
            front = browser.get("/demo/rehearsal", base_url=origin)
            self.assertEqual(front.status_code, 200)
            cookie = front.headers["Set-Cookie"]
            self.assertIn("Secure", cookie)
            self.assertIn("HttpOnly", cookie)
            front.close()
            accepted = browser.post(api, base_url=origin, json={}, headers={"Origin": origin})
            self.assertEqual(accepted.status_code, 201)
            project = accepted.json["id"]
            self.assertEqual(browser.get(f"{api}/{project}/database", base_url=origin).status_code, 200)
            self.assertEqual(outsider.get(api, base_url=origin).json["projects"], [])
            self.assertEqual(outsider.get(f"{api}/{project}/materials", base_url=origin).status_code, 404)
            self.assertEqual(browser.post(api, base_url=origin, json={}, headers={"Origin": "https://other.example.org"}).status_code, 403)
            self.assertEqual(browser.get("/demo/session", base_url=origin).status_code, 404)
