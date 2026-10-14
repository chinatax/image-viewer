// 持久化用户上次选择的根文件夹句柄（IndexedDB），下次打开页面时自动恢复。
// 配合 fs.queryPermission：Chrome 若已记住该目录的读权限，则无需任何弹窗直接进入。
//
// 存的是一个**数组**：用户可以把 DCIM、Pictures 等好几个文件夹合并成一个根
//（见 fs.ts 的 MergedDir），下次打开时整组一起恢复。

const DB_NAME = "imageviewer-handle";
const DB_VERSION = 1;
const STORE = "dir";
const KEY = "roots";
const LEGACY_KEY = "root"; // v1 早期版本在这里存单个句柄，读的时候兼容一下

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveDirHandles(handles: FileSystemDirectoryHandle[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      // 一次事务里写完，避免"旧的删了新的没写进去"导致下次打开空手。
      //
      // 只选了一个文件夹时仍旧写老键：完全模式（桌面）的磁盘状态因此和加多根
      // 之前一字不差，升级后不会出现"存了两份、行为却变了"的情况。
      if (handles.length === 1) {
        store.put(handles[0], LEGACY_KEY);
        store.delete(KEY);
      } else {
        store.put(handles, KEY);
        store.delete(LEGACY_KEY);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 忽略持久化失败 */
  }
}

// 每次读单独开事务：中间 await 的话事务会自动提交，第二个请求就发不出去了。
async function readKey(key: string): Promise<unknown> {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadDirHandles(): Promise<FileSystemDirectoryHandle[]> {
  try {
    const stored = await readKey(KEY);
    if (Array.isArray(stored)) return stored as FileSystemDirectoryHandle[];
    // 老版本存的单句柄，当成只有一个根
    const legacy = await readKey(LEGACY_KEY);
    return legacy ? [legacy as FileSystemDirectoryHandle] : [];
  } catch {
    return [];
  }
}
