const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rimraf = require('rimraf');
const { unzipSync } = require('cross-zip');
const { color, fatal } = require('./logging');
const depot = require('./depot-tools');
const os = require('os');
const { getIsArm } = require('./arm');

const gomaDir = path.resolve(__dirname, '..', '..', 'third_party', 'goma');
const gomaGnFile = path.resolve(__dirname, '..', '..', 'third_party', 'goma.gn');
const gomaShaFile = path.resolve(__dirname, '..', '..', 'third_party', 'goma', '.sha');
const gomaBaseURL = 'https://dev-cdn.electronjs.org/goma-clients';
const gomaLoginFile = path.resolve(gomaDir, 'last-known-login');

let gomaPlatform = process.platform;

if (gomaPlatform === 'darwin' && getIsArm()) {
  gomaPlatform = 'darwin-arm64';
}

const GOMA_PLATFORM_SHAS = {
  darwin: 'bc4bdbe0f687cb6bf1848500704cfa24bc5bee167e768bc6c5c689417c0c44c0',
  'darwin-arm64': '29e3e20903c780c717a1fbeb6be78ce40d70e136d1949eec6307ad11aade9447',
  linux: 'c105c1a4d06761a4bfcae70789e757f409e4fdf4423b50328c5864bf3d639561',
  win32: 'd7578905bb8c0d01249fc1ec6cfb7bfa6a68580ac7f5f5b95b653bce07ba8bf1',
};

const MSFT_GOMA_PLATFORM_SHAS = {
  darwin: '4738c5447b8a7bafbb6adb9df01b2f571b492ada862bd3e296892faf5b617df1',
  'darwin-arm64': '4d2a6d98ecd5214731c089622991334e083f42100bca194a087dde7136a07fc8',
  linux: 'dd6285146677b0134fb9b4a0b4f8341c7e57a9b4ef82db158de95f7fed5b72e2',
  win32: '06b6c1d5c924a7415395545ee7a99b926829fc104336830ce6385b7ba67576cd',
};

const isSupportedPlatform = !!GOMA_PLATFORM_SHAS[gomaPlatform];

function downloadAndPrepareGoma(config) {
  if (!isSupportedPlatform) return;

  if (!fs.existsSync(path.dirname(gomaDir))) {
    fs.mkdirSync(path.dirname(gomaDir));
  }

  const gomaGnContents = `goma_dir = "${gomaDir}"\nuse_goma = true`;
  if (!fs.existsSync(gomaGnFile) || fs.readFileSync(gomaGnFile, 'utf8') !== gomaGnContents) {
    console.log(`Writing new goma.gn file ${color.path(gomaGnFile)}`);
    fs.writeFileSync(gomaGnFile, gomaGnContents);
  }
  let sha = GOMA_PLATFORM_SHAS[gomaPlatform];
  if (config && config.gomaSource === 'msft') {
    sha = MSFT_GOMA_PLATFORM_SHAS[gomaPlatform];
  }
  if (
    fs.existsSync(gomaShaFile) &&
    fs.readFileSync(gomaShaFile, 'utf8') === sha &&
    !process.env.ELECTRON_FORGE_GOMA_REDOWNLOAD
  )
    return sha;

  const filename = {
    darwin: 'goma-mac.tgz',
    'darwin-arm64': 'goma-mac-arm64.tgz',
    linux: 'goma-linux.tgz',
    win32: 'goma-win.zip',
  }[gomaPlatform];

  if (fs.existsSync(path.resolve(gomaDir, 'goma_ctl.py'))) {
    depot.execFileSync(config, 'python3', ['goma_ctl.py', 'stop'], {
      cwd: gomaDir,
      stdio: ['ignore'],
    });
  }

  const tmpDownload = path.resolve(gomaDir, '..', filename);
  // Clean Up
  rimraf.sync(gomaDir);
  rimraf.sync(tmpDownload);

  const downloadURL = `${gomaBaseURL}/${sha}/${filename}`;
  console.log(`Downloading ${color.cmd(downloadURL)} into ${color.path(tmpDownload)}`);
  childProcess.spawnSync(
    process.execPath,
    [path.resolve(__dirname, '..', 'download.js'), downloadURL, tmpDownload],
    {
      stdio: 'inherit',
    },
  );
  const hash = crypto
    .createHash('SHA256')
    .update(fs.readFileSync(tmpDownload))
    .digest('hex');
  if (hash !== sha) {
    console.error(
      `${color.err} Got hash for downloaded file ${color.cmd(hash)} which did not match ${color.cmd(
        sha,
      )}. Halting now`,
    );
    rimraf.sync(tmpDownload);
    process.exit(1);
  }

  const targetDir = path.resolve(tmpDownload, '..');
  if (filename.endsWith('.tgz')) {
    const result = childProcess.spawnSync('tar', ['zxvf', filename], {
      cwd: targetDir,
    });
    if (result.status !== 0) {
      fatal('Failed to extract goma');
    }
  } else {
    unzipSync(tmpDownload, targetDir);
  }
  rimraf.sync(tmpDownload);
  fs.writeFileSync(gomaShaFile, sha);
  return sha;
}

function gomaIsAuthenticated(config) {
  if (!isSupportedPlatform) return false;
  const lastKnownLogin = getLastKnownLoginTime();
  // Assume if we authed in the last 12 hours it is still valid
  if (lastKnownLogin && Date.now() - lastKnownLogin.getTime() < 1000 * 60 * 60 * 12) return true;

  let loggedInInfo;
  try {
    loggedInInfo = depot.execFileSync(config, 'python3', ['goma_auth.py', 'info'], {
      cwd: gomaDir,
      stdio: ['ignore'],
    });
  } catch {
    return false;
  }

  const loggedInPattern = /^Login as (\w+\s\w+)$/;
  return loggedInPattern.test(loggedInInfo.toString().trim());
}

function authenticateGoma(config) {
  if (!isSupportedPlatform) return;

  downloadAndPrepareGoma(config);

  if (!gomaIsAuthenticated(config)) {
    const { status, error } = depot.spawnSync(config, 'python3', ['goma_auth.py', 'login'], {
      cwd: gomaDir,
      stdio: 'inherit',
      env: {
        AGREE_NOTGOMA_TOS: '1',
      },
    });

    if (status !== 0) {
      let errorMsg = `Failed to run command:`;
      if (status !== null) errorMsg += `\n Exit Code: "${status}"`;
      if (error) errorMsg += `\n ${error}`;
      fatal(errorMsg, status);
    }

    recordGomaLoginTime();
  }
}

function getLastKnownLoginTime() {
  if (!fs.existsSync(gomaLoginFile)) return null;
  const contents = fs.readFileSync(gomaLoginFile);
  return new Date(parseInt(contents, 10));
}

function clearGomaLoginTime() {
  if (!fs.existsSync(gomaLoginFile)) return;
  fs.unlinkSync(gomaLoginFile);
}

function recordGomaLoginTime() {
  fs.writeFileSync(gomaLoginFile, `${Date.now()}`);
}

function ensureGomaStart(config) {
  // GomaCC is super fast and we can assume that a 0 exit code means we are good-to-go
  const gomacc = path.resolve(gomaDir, process.platform === 'win32' ? 'gomacc.exe' : 'gomacc');
  const { status } = childProcess.spawnSync(gomacc, ['port', '2']);
  if (status === 0) return;

  // Set number of subprocs to equal number of CPUs for MacOS
  let subprocs = {};
  if (process.platform === 'darwin') {
    const cpus = os.cpus().length;
    subprocs = {
      GOMA_MAX_SUBPROCS: cpus.toString(),
      GOMA_MAX_SUBPROCS_LOW: cpus.toString(),
    };
  }

  depot.execFileSync(config, 'python3', ['goma_ctl.py', 'ensure_start'], {
    cwd: gomaDir,
    env: {
      ...gomaEnv(config),
      ...subprocs,
    },
    // Inherit stdio on Windows because otherwise this never terminates
    stdio: process.platform === 'win32' ? 'inherit' : ['ignore'],
  });
}

function gomaAuthFailureEnv(config) {
  let isCacheOnly = config && config.goma === 'cache-only';
  if (!config) {
    // If no config is provided we are running in CI, infer cache-only from the presence
    // of the RAW_GOMA_AUTH env var
    isCacheOnly = !process.env.RAW_GOMA_AUTH;
  }
  if (isCacheOnly) {
    return {
      GOMA_FALLBACK_ON_AUTH_FAILURE: 'true',
    };
  }
  return {};
}

function gomaCIEnv(config) {
  if (!config && process.env.CI) {
    return {
      // Automatically start the compiler proxy when it dies in CI, random flakes be random
      GOMA_START_COMPILER_PROXY: 'true',
    };
  }
  return {};
}

function gomaEnv(config) {
  return {
    ...gomaAuthFailureEnv(config),
    ...gomaCIEnv(config),
  };
}

module.exports = {
  isAuthenticated: gomaIsAuthenticated,
  auth: authenticateGoma,
  ensure: ensureGomaStart,
  dir: gomaDir,
  downloadAndPrepare: downloadAndPrepareGoma,
  gnFilePath: gomaGnFile,
  env: gomaEnv,
  clearGomaLoginTime,
  recordGomaLoginTime,
};
