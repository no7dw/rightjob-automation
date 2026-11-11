// IndexedDB separates potentially large screenshots from the small run checkpoint.
export async function evidenceDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("jseeker-evidence", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("images");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function evidencePut(key, value) {
  const db = await evidenceDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("images", "readwrite");
      tx.objectStore("images").put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function evidenceGet(key) {
  const db = await evidenceDB();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction("images").objectStore("images").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
export function initialRun(scope, target = 10) {
  if (!Number.isInteger(target) || target < 1)
    throw new Error("采集条数须为不小于1的整数");
  return {
    id: crypto.randomUUID(),
    started_at: new Date().toISOString(),
    scope,
    status: "idle",
    jobs: [],
    attempts: [],
    scores: {},
    applications: {},
    review: {},
    corrections: {},
    seen: [],
    stop_reason: null,
    target,
  };
}
