import {definition as nodeDefinition} from "../node-editor/node-model.js";
import {localCollection, versionKey} from "../parameter-editor/workbench-storage.js";

export const flowLibrary = localCollection("skyao-static-flow-library-v1");

export function newFlow() {
  return {
    id: "F-" + crypto.randomUUID().slice(0, 13).toUpperCase(),
    name: "", description: "", version: 1, revision: 0, status: "draft", updated_at: null,
    sections: [], section_counter: 0, entry_counter: 0, node_snapshots: {},
  };
}

export function newSection(flow) {
  const section = {id: "S" + ++flow.section_counter, title: "", nodes: []};
  flow.sections.push(section);
  return section;
}

export function pinNode(flow, entry, node) {
  entry.node_id = node.id;
  entry.node_version = node.version;
  const key = versionKey(node);
  // A single immutable recovery copy serves every occurrence of this node version.
  if (!Object.hasOwn(flow.node_snapshots, key)) flow.node_snapshots[key] = nodeDefinition(node);
}

export function addEntry(flow, section, node) {
  const entry = {id: "E" + ++flow.entry_counter};
  pinNode(flow, entry, node);
  section.nodes.push(entry);
  return entry;
}

export function confirmedVersions(nodes, id) {
  return nodes.filter(node => node.status === "confirmed" && (!id || node.id === id))
    .sort((a, b) => b.version - a.version);
}

function refKey(entry) {
  return versionKey({id: entry.node_id, version: entry.node_version});
}

export function resolveNode(flow, entry, nodes) {
  const live = nodes.find(node => node.id === entry.node_id && node.version === entry.node_version);
  const snapshot = flow.node_snapshots?.[refKey(entry)];
  const node = snapshot ?? live;
  if (!node || node.id !== entry.node_id || node.version !== entry.node_version ||
      node.status !== "confirmed" || !Array.isArray(node.results) || !Array.isArray(node.reanalysis?.parameters)) return null;
  return node;
}

export function definition(flow) {
  const {id, name, description, version, status, updated_at, sections} = flow;
  return {
    id, name: name.trim(), description, version, status, updated_at,
    sections: sections.map(section => ({
      id: section.id, title: section.title.trim(),
      nodes: section.nodes.map(({id, node_id, node_version}) => ({id, node_id, node_version})),
    })),
  };
}

export function recordForSave(flow) {
  const visible = definition(flow);
  const snapshots = new Set(visible.sections.flatMap(section => section.nodes.map(refKey)));
  return {
    ...visible, section_counter: flow.section_counter, entry_counter: flow.entry_counter,
    node_snapshots: Object.fromEntries(Object.entries(flow.node_snapshots).filter(([key]) => snapshots.has(key))),
  };
}

export function definitionIssues(flow, nodes) {
  const issues = [];
  if (!flow.name.trim()) issues.push("请填写云流程名称。");
  if (!flow.sections.length) issues.push("请至少添加一个一级标题。");
  const sections = new Set();
  const entries = new Set();
  for (const section of flow.sections) {
    if (sections.has(section.id)) issues.push(`一级标题编号 ${section.id} 重复。`);
    sections.add(section.id);
    if (!section.title.trim()) issues.push(`${section.id} 缺少一级标题名称。`);
    if (!section.nodes.length) issues.push(`${section.title.trim() || section.id} 至少需要一个节点。`);
    for (const entry of section.nodes) {
      if (entries.has(entry.id)) issues.push(`流程条目编号 ${entry.id} 重复。`);
      entries.add(entry.id);
      if (!resolveNode(flow, entry, nodes)) issues.push(`${entry.id} 无法解析已确认节点 ${entry.node_id} v${entry.node_version}。`);
    }
  }
  return issues;
}
