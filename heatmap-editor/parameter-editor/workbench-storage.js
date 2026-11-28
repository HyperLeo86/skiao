// Both editors read the installed parameter library under its original storage key.
export const parameterStorageKey = "skyao-static-parameter-library-v1";
const parameterSeed = new URL("./parameters.json", import.meta.url);
let parameterSeeds;

export function localCollection(key, seed = async () => []) {
  async function read() {
    const saved = localStorage.getItem(key);
    return saved === null ? structuredClone(await seed()) : JSON.parse(saved);
  }

  async function update(mutate) {
    const persist = async () => {
      const records = await read();
      const result = mutate(records);
      localStorage.setItem(key, JSON.stringify(records));
      return result;
    };
    return navigator.locks ? navigator.locks.request(key, persist) : persist();
  }

  return {read, update};
}

export const parameterLibrary = localCollection(parameterStorageKey, async () => {
  if (!parameterSeeds) {
    const response = await fetch(parameterSeed);
    if (!response.ok) throw new Error("无法加载示例参数。");
    parameterSeeds = await response.json();
  }
  return parameterSeeds;
});

export const versionKey = record => `${record.id}@${record.version}`;

export function saveVersion(library, item, action, normalize) {
  return library.update(records => {
    const index = records.findIndex(record => versionKey(record) === versionKey(item));
    const stored = records[index];
    if (item.revision && (!stored || stored.revision !== item.revision)) {
      throw new Error("这张卡已在其他页面更新，请刷新后重试。");
    }
    if (!item.revision && stored) throw new Error("编号已存在，请重新新增。");
    const creating = action === "new_version";
    if (creating && (stored?.status !== "confirmed" || records.some(record => record.id === item.id && record.version > item.version))) {
      throw new Error("请从最新的已确认版本创建新版本。");
    }
    if (!creating && stored?.status === "confirmed") throw new Error("请另存新版本后编辑。");
    if (action === "confirmed" && stored?.status !== "pending") throw new Error("请先提交待确认。");
    const record = {
      ...normalize(creating ? stored : item),
      version: creating ? item.version + 1 : item.version,
      status: creating ? "draft" : action,
      revision: creating ? 1 : item.revision + 1,
      updated_at: new Date().toISOString(),
    };
    if (creating || index < 0) records.unshift(record);
    else records[index] = record;
    return {record, records};
  });
}
