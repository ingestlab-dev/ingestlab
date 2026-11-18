
const DIR = 'ingestlab-cache';

function sha256Hex(bytes) {
  return crypto.subtle
    .digest('SHA-256', bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

const memory = new Map();

async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

/**
 * Build a cache facade for one input file.
 * @param {Uint8Array} bytes
 * @param {string} version engine version (part of the key -> safe upgrades)
 * @returns {Promise<{backend: 'opfs'|'memory', key: string, get: Function, put: Function}>}
 */
export async function cacheForBytes(bytes, version) {
  let backend = 'memory';
  let dir = null;
  try {
    if (globalThis.navigator?.storage?.getDirectory) {
      dir = await opfsDir();
      backend = 'opfs';
    }
  } catch {
    dir = null;
    backend = 'memory';
  }

  const key = `${version}:${await sha256Hex(bytes)}`;

  const get = async () => {
    try {
      if (dir) {
        const fh = await dir.getFileHandle(`${key}.json`);
        const text = await (await fh.getFile()).text();
        return JSON.parse(text);
      }
      return memory.get(key) ?? null;
    } catch {
      return null;
    }
  };

  const put = async (value) => {
    try {
      const text = JSON.stringify(value);
      if (dir) {
        const fh = await dir.getFileHandle(`${key}.json`, { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
      } else {
        memory.set(key, value);
      }
    } catch {
    }
  };

  const clear = async () => {
    memory.clear();
    try {
      if (dir) await dir.removeEntry(`${key}.json`);
    } catch {
    }
  };

  return { backend, key, get, put, clear };
}
