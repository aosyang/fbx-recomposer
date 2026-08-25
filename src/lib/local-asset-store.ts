const DB_NAME = "fbx-viewer-local-assets";
const DB_VERSION = 1;
const ASSET_STORE = "assets";
const STATE_STORE = "state";
const LAST_SCENE_KEY = "last-scene";

export type LocalAssetKind = "model" | "animation";

export type LocalAssetSummary = {
  id: string;
  kind: LocalAssetKind;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  createdAt: number;
  updatedAt: number;
  resourceCount: number;
};

export type LocalAssetBundle = {
  asset: LocalAssetSummary;
  file: File;
  resources: File[];
};

export type LastSceneManifest = {
  modelAssetId?: string;
  animationAssetId?: string;
  selectedClipIndex?: number;
  updatedAt: number;
};

type StoredResource = {
  name: string;
  type: string;
  lastModified: number;
  path: string;
  blob: Blob;
};

type StoredAssetRecord = LocalAssetSummary & {
  blob: Blob;
  resources: StoredResource[];
};

type StateRecord<T> = {
  key: string;
  value: T;
};

type ResourceFile = File & {
  resourcePath?: string;
  webkitRelativePath?: string;
};

function getIndexedDb() {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this browser.");
  }
  return indexedDB;
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = getIndexedDb().open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Failed to open local asset database."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ASSET_STORE)) {
        const assets = database.createObjectStore(ASSET_STORE, { keyPath: "id" });
        assets.createIndex("kind", "kind", { unique: false });
        assets.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(STATE_STORE)) {
        database.createObjectStore(STATE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function resourcePath(file: File) {
  const browserFile = file as ResourceFile;
  return browserFile.resourcePath || browserFile.webkitRelativePath || file.name;
}

function toStoredResource(file: File): StoredResource {
  return {
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    path: resourcePath(file),
    blob: file.slice(0, file.size, file.type),
  };
}

function toSummary(record: StoredAssetRecord): LocalAssetSummary {
  const {
    id,
    kind,
    name,
    type,
    size,
    lastModified,
    createdAt,
    updatedAt,
    resourceCount,
  } = record;
  return {
    id,
    kind,
    name,
    type,
    size,
    lastModified,
    createdAt,
    updatedAt,
    resourceCount,
  };
}

function restoreResource(record: StoredResource) {
  const file = new File([record.blob], record.name, {
    type: record.type,
    lastModified: record.lastModified,
  }) as ResourceFile;
  Object.defineProperty(file, "resourcePath", {
    configurable: false,
    enumerable: false,
    value: record.path,
  });
  return file;
}

export function isLocalAssetStorageAvailable() {
  return typeof indexedDB !== "undefined";
}

export async function saveLocalAsset(
  kind: LocalAssetKind,
  file: File,
  resources: File[] = [],
) {
  const database = await openDatabase();
  try {
    const now = Date.now();
    const record: StoredAssetRecord = {
      id: createId(),
      kind,
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      createdAt: now,
      updatedAt: now,
      resourceCount: resources.length,
      blob: file.slice(0, file.size, file.type),
      resources: resources.map(toStoredResource),
    };
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    transaction.objectStore(ASSET_STORE).put(record);
    await transactionDone(transaction);
    return toSummary(record);
  } finally {
    database.close();
  }
}

export async function getLocalAsset(id: string): Promise<LocalAssetBundle | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE, "readonly");
    const record = await requestToPromise(
      transaction.objectStore(ASSET_STORE).get(id) as IDBRequest<StoredAssetRecord | undefined>,
    );
    await transactionDone(transaction);
    if (!record) return null;
    return {
      asset: toSummary(record),
      file: new File([record.blob], record.name, {
        type: record.type,
        lastModified: record.lastModified,
      }),
      resources: record.resources.map(restoreResource),
    };
  } finally {
    database.close();
  }
}

export async function listLocalAssets(kind?: LocalAssetKind) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE, "readonly");
    const store = transaction.objectStore(ASSET_STORE);
    const request = kind
      ? store.index("kind").getAll(kind)
      : store.getAll();
    const records = await requestToPromise(request as IDBRequest<StoredAssetRecord[]>);
    await transactionDone(transaction);
    return records
      .map(toSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  } finally {
    database.close();
  }
}

export async function deleteLocalAsset(id: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    transaction.objectStore(ASSET_STORE).delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function clearLocalAssets() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    transaction.objectStore(ASSET_STORE).clear();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function getLastSceneManifest(): Promise<LastSceneManifest | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STATE_STORE, "readonly");
    const record = await requestToPromise(
      transaction.objectStore(STATE_STORE).get(LAST_SCENE_KEY) as IDBRequest<StateRecord<LastSceneManifest> | undefined>,
    );
    await transactionDone(transaction);
    return record?.value ?? null;
  } finally {
    database.close();
  }
}

export async function setLastSceneManifest(
  manifest: Omit<LastSceneManifest, "updatedAt"> | null,
) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STATE_STORE, "readwrite");
    const store = transaction.objectStore(STATE_STORE);
    if (manifest) {
      const record: StateRecord<LastSceneManifest> = {
        key: LAST_SCENE_KEY,
        value: { ...manifest, updatedAt: Date.now() },
      };
      store.put(record);
    } else {
      store.delete(LAST_SCENE_KEY);
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
