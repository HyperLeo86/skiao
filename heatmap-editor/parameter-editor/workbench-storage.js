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
