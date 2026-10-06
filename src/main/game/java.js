import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { downloadAll, downloadFile, fetchJson } from '../net/download.js';

const MOJANG_RUNTIMES = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

/** Clé de plateforme utilisée par les runtimes Java de Mojang. */
function mojangPlatform() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  if (platform === 'win32') return arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (platform === 'linux') return arch === 'ia32' ? 'linux-i386' : arch === 'x64' ? 'linux' : null;
  return null;
}

/** Chemin de l'exécutable java dans un runtime Mojang. */
function mojangJavaBin(dir) {
  if (process.platform === 'darwin') return path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  if (process.platform === 'win32') return path.join(dir, 'bin', 'javaw.exe');
  return path.join(dir, 'bin', 'java');
}

/** Lance `java -version` pour vérifier que l'exécutable fonctionne et renvoie la version majeure. */
export function probeJava(javaPath) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(javaPath, ['-version'], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    child.stderr.on('data', (d) => (out += d));
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const m = out.match(/version "(\d+)(?:\.(\d+))?/);
      if (!m) return resolve(null);
      const major = m[1] === '1' ? Number(m[2]) : Number(m[1]);
      resolve({ major, raw: out.split('\n')[0].trim() });
    });
  });
}

async function installMojangRuntime({ dir, component, repair, onProgress, signal }) {
  const key = mojangPlatform();
  if (!key) return null;

  // Runtime déjà installé : aucun accès réseau nécessaire (permet de jouer hors-ligne).
  const markerFile = path.join(dir, '.pdlv-runtime.json');
  const javaBin = mojangJavaBin(dir);
  const marker = await fs
    .readFile(markerFile, 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  if (!repair && marker?.component === component && existsSync(javaBin)) return javaBin;

  const all = await fetchJson(MOJANG_RUNTIMES);
  const target = all[key]?.[component]?.[0];
  if (!target) return null;

  const manifest = await fetchJson(target.manifest.url);
  const entries = Object.entries(manifest.files);

  for (const [rel, e] of entries) {
    if (e.type === 'directory') await fs.mkdir(path.join(dir, rel), { recursive: true });
  }

  const files = entries
    .filter(([, e]) => e.type === 'file')
    .map(([rel, e]) => ({
      url: e.downloads.raw.url,
      sha1: e.downloads.raw.sha1,
      size: e.downloads.raw.size,
      dest: path.join(dir, rel),
      executable: e.executable,
    }));
  await downloadAll(files, { concurrency: 16, verify: 'sha1', onProgress, signal });

  if (process.platform !== 'win32') {
    for (const f of files) if (f.executable) await fs.chmod(f.dest, 0o755);
    for (const [rel, e] of entries) {
      if (e.type !== 'link') continue;
      const linkPath = path.join(dir, rel);
      await fs.rm(linkPath, { force: true });
      await fs.symlink(e.target, linkPath);
    }
  }

  await fs.writeFile(markerFile, JSON.stringify({ component, sha1: target.manifest.sha1, version: target.version }));
  return javaBin;
}

/** Repli pour les plateformes sans runtime Mojang (ex. Linux ARM) : JRE Eclipse Temurin. */
async function installAdoptium({ dir, majorVersion, onProgress, signal }) {
  const os = { darwin: 'mac', win32: 'windows', linux: 'linux' }[process.platform];
  const arch = { x64: 'x64', arm64: 'aarch64', ia32: 'x32', arm: 'arm' }[process.arch];
  if (!os || !arch) throw new Error(`Plateforme non prise en charge : ${process.platform}/${process.arch}`);

  const findJava = async () => {
    const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
    for (const sub of await fs.readdir(dir).catch(() => [])) {
      for (const candidate of [path.join(dir, sub, 'bin', exe), path.join(dir, sub, 'Contents', 'Home', 'bin', exe)]) {
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  };
  const existing = await findJava();
  if (existing) return existing;

  const api = `https://api.adoptium.net/v3/assets/latest/${majorVersion}/hotspot?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`;
  const [asset] = await fetchJson(api);
  if (!asset) throw new Error('Aucun Java compatible trouvé pour cette plateforme.');
  const pkg = asset.binary.package;
  const archive = path.join(dir, '..', pkg.name);
  let done = 0;
  await downloadFile(
    { url: pkg.link, dest: archive, sha256: pkg.checksum, size: pkg.size },
    {
      signal,
      onBytes: (n) => {
        done += n;
        onProgress?.({ phase: 'download', done, total: pkg.size, files: 0, totalFiles: 1 });
      },
    },
  );
  await fs.mkdir(dir, { recursive: true });
  // `tar` est disponible sur macOS, Linux et Windows 10+ (et sait lire les .zip sous Windows).
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', dir], { windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Extraction de Java impossible (code ${code})`))));
  });
  await fs.rm(archive, { force: true });
  const java = await findJava();
  if (!java) throw new Error('Java installé mais introuvable.');
  return java;
}

/**
 * Garantit qu'un Java compatible est disponible et renvoie le chemin de l'exécutable.
 * - customPath : Java choisi par l'utilisateur dans les paramètres (prioritaire)
 * - component  : runtime Mojang indiqué par le version.json (java-runtime-gamma pour 1.20.1)
 */
export async function ensureJava({ runtimeRoot, component, majorVersion, customPath, repair, onProgress, signal }) {
  if (customPath) {
    const probe = await probeJava(customPath);
    if (!probe) throw new Error(`Le Java configuré ne fonctionne pas : ${customPath}`);
    if (probe.major < majorVersion) {
      throw new Error(`Le Java configuré est trop ancien (Java ${probe.major}, Java ${majorVersion} requis).`);
    }
    return customPath;
  }

  const mojang = await installMojangRuntime({
    dir: path.join(runtimeRoot, component),
    component,
    repair,
    onProgress,
    signal,
  });
  if (mojang) return mojang;
  return installAdoptium({ dir: path.join(runtimeRoot, `temurin-${majorVersion}`), majorVersion, onProgress, signal });
}
