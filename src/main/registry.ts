import { execFile, ExecFileOptions, execFileSync } from 'child_process';
import { basename, join, normalize } from 'path';
import * as path from 'path';
import * as semver from 'semver';
import * as fs from 'fs';
import log from 'electron-log';
const which = require('which');
const WinRegistry = require('winreg');
import {
  EnvironmentTypeName,
  IEnvironmentType,
  IPythonEnvironment,
  IVersionContainer
} from './tokens';
import {
  getBundledPythonEnvPath,
  getBundledPythonPath,
  getUserHomeDir,
  isPortInUse
} from './utils';
import { appData, FrontEndMode, SettingType, userSettings } from './settings';

const envInfoPyCode = fs
  .readFileSync(path.join(__dirname, 'env_info.py'))
  .toString();

export interface IRegistry {
  getDefaultEnvironment: () => Promise<IPythonEnvironment>;
  getEnvironmentByPath: (pythonPath: string) => IPythonEnvironment;
  getEnvironmentList: () => Promise<IPythonEnvironment[]>;
  addEnvironment: (pythonPath: string) => IPythonEnvironment;
  validatePythonEnvironmentAtPath: (pythonPath: string) => boolean;
  validateCondaBaseEnvironmentAtPath: (envPath: string) => boolean;
  setDefaultPythonPath: (pythonPath: string) => void;
  getCurrentPythonEnvironment: () => IPythonEnvironment;
  getAdditionalPathIncludesForPythonPath: (pythonPath: string) => string;
  getRequirements: () => Registry.IRequirement[];
  getEnvironmentInfo(pythonPath: string): Promise<IPythonEnvironment>;
  getRunningServerList(): Promise<string[]>;
}

export class Registry implements IRegistry {
  constructor() {
    const minJLabVersionRequired =
      userSettings.getValue(SettingType.frontEndMode) === FrontEndMode.ClientApp
        ? '3.4.5'
        : '3.0.0';

    this._requirements = [
      {
        name: 'jupyterlab',
        moduleName: 'jupyterlab',
        commands: ['--version'],
        versionRange: new semver.Range(`>=${minJLabVersionRequired}`)
      }
    ];

    // initialize environment list and default
    this._environments = [
      ...appData.discoveredPythonEnvs,
      ...appData.userSetPythonEnvs
    ].filter(env => this._pathExistsSync(env.path));

    let pythonPath = userSettings.getValue(SettingType.pythonPath);
    if (pythonPath === '') {
      pythonPath = getBundledPythonPath();
    }

    const defaultEnv = this._resolveEnvironmentSync(pythonPath);

    if (defaultEnv) {
      this._defaultEnv = defaultEnv;
    }

    const pathEnvironments = this._loadPathEnvironments();
    const condaEnvironments = this._loadCondaEnvironments();
    const allEnvironments = [pathEnvironments, condaEnvironments];
    if (process.platform === 'win32') {
      let windowRegEnvironments = this._loadWindowsRegistryEnvironments(
        this._requirements
      );
      allEnvironments.push(windowRegEnvironments);
    }

    this._registryBuilt = Promise.all<IPythonEnvironment[]>(allEnvironments)
      .then(async environments => {
        let discoveredEnvs = [].concat(...environments);
        discoveredEnvs = await this._resolveEnvironments(discoveredEnvs, true);
        this._discoveredEnvironments = discoveredEnvs;
        this._userSetEnvironments = await this._resolveEnvironments(
          appData.userSetPythonEnvs,
          true
        );
        this._updateEnvironments();

        if (!this._defaultEnv && this._environments.length > 0) {
          this._defaultEnv = this._environments[0];
        }
        return;
      })
      .catch(reason => {
        if (reason.fileName || reason.lineNumber) {
          log.error(
            `Registry building failed! ${reason.name} at ${reason.fileName}:${reason.lineNumber}: ${reason.message}`
          );
        } else if (reason.stack) {
          log.error(
            `Registry building failed! ${reason.name}: ${reason.message}`
          );
          log.error(reason.stack);
        } else {
          log.error(
            `Registry building failed! ${reason.name}: ${reason.message}`
          );
        }
      });
  }

  private async _resolveEnvironments(
    envs: IPythonEnvironment[],
    sort?: boolean
  ): Promise<IPythonEnvironment[]> {
    const uniqueEnvs = this._getUniqueObjects(envs, env => {
      return env.path;
    });

    const resolvedEnvs = await Promise.all(
      uniqueEnvs.map(async env => await this._resolveEnvironment(env.path))
    );
    const filteredEnvs = resolvedEnvs.filter(env => env !== undefined);

    if (sort) {
      this._sortEnvironments(filteredEnvs, this._requirements);
    }

    return filteredEnvs;
  }

  private async _resolveEnvironment(
    pythonPath: string
  ): Promise<IPythonEnvironment> {
    if (!(await this._pathExists(pythonPath))) {
      return;
    }

    const env = await this.getEnvironmentInfo(pythonPath);

    if (
      env &&
      this._environmentSatisfiesRequirements(env, this._requirements)
    ) {
      return env;
    }
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  private _resolveEnvironmentSync(pythonPath: string): IPythonEnvironment {
    if (!this._pathExistsSync(pythonPath)) {
      return;
    }

    const env = this.getEnvironmentInfoSync(pythonPath);

    if (
      env &&
      this._environmentSatisfiesRequirements(env, this._requirements)
    ) {
      return env;
    }
  }

  /**
   * Retrieve the default environment from the registry, once it has been resolved
   *
   * @returns a promise containing the default environment
   */
  getDefaultEnvironment(): Promise<IPythonEnvironment> {
    if (this._defaultEnv) {
      return Promise.resolve(this._defaultEnv);
    } else {
      return new Promise((resolve, reject) => {
        this._registryBuilt
          .then(() => {
            if (this._defaultEnv) {
              resolve(this._defaultEnv);
            } else {
              reject(new Error(`No default environment found!`));
            }
          })
          .catch(reason => {
            reject(
              new Error(`Default environment could not be obtained: ${reason}`)
            );
          });
      });
    }
  }

  getEnvironmentByPath(pythonPath: string): IPythonEnvironment {
    return this._environments.find(env => pythonPath === env.path);
  }

  /**
   * Retrieve the complete list of environments, once they have been resolved
   * @returns a promise that resolves to a complete list of environments
   */
  getEnvironmentList(): Promise<IPythonEnvironment[]> {
    if (this._environments.length > 0) {
      return Promise.resolve(this._environments);
    } else {
      return new Promise((resolve, reject) => {
        this._registryBuilt
          .then(() => {
            if (this._environments) {
              resolve(this._environments);
            } else {
              reject(new Error(`No environment list found!`));
            }
          })
          .catch(reason => {
            reject(
              new Error(`Environment list could not be obtained: ${reason}`)
            );
          });
      });
    }
  }

  /**
   * Create a new environment from a python executable, without waiting for the
   * entire registry to be resolved first.
   * @param pythonPath The location of the python executable to create an environment from
   */
  addEnvironment(pythonPath: string): IPythonEnvironment {
    const inDiscoveredEnvList = this._discoveredEnvironments.find(
      env => pythonPath === env.path
    );
    if (inDiscoveredEnvList) {
      return inDiscoveredEnvList;
    }

    const inUserSetEnvList = this._userSetEnvironments.find(
      env => pythonPath === env.path
    );
    if (inUserSetEnvList) {
      return inUserSetEnvList;
    }

    const env = this._resolveEnvironmentSync(pythonPath);
    if (env) {
      this._userSetEnvironments.push(env);
      this._updateEnvironments();
    }
    return env;
  }

  validatePythonEnvironmentAtPath(pythonPath: string): boolean {
    return this._resolveEnvironment(pythonPath) !== undefined;
  }

  validateCondaBaseEnvironmentAtPath(envPath: string): boolean {
    const isWin = process.platform === 'win32';
    const condaBinPath = path.join(
      envPath,
      'condabin',
      isWin ? 'conda.bat' : 'conda'
    );
    return fs.existsSync(condaBinPath) && fs.lstatSync(condaBinPath).isFile();
  }

  async getEnvironmentInfo(pythonPath: string): Promise<IPythonEnvironment> {
    const envInfoOut = await this._runCommand(pythonPath, [
      '-c',
      envInfoPyCode
    ]);
    const envInfo = JSON.parse(envInfoOut.trim());
    const envType =
      envInfo.type === 'conda-root'
        ? IEnvironmentType.CondaRoot
        : envInfo.type === 'conda-env'
        ? IEnvironmentType.CondaEnv
        : IEnvironmentType.VirtualEnv;
    const envName = `${EnvironmentTypeName[envType]}: ${envInfo.name}`;

    return {
      path: pythonPath,
      type: envType,
      name: envName,
      versions: envInfo.versions
    };
  }

  getEnvironmentInfoSync(pythonPath: string): IPythonEnvironment {
    const envInfoOut = this._runCommandSync(pythonPath, ['-c', envInfoPyCode]);
    const envInfo = JSON.parse(envInfoOut.trim());
    const envType =
      envInfo.type === 'conda-root'
        ? IEnvironmentType.CondaRoot
        : envInfo.type === 'conda-env'
        ? IEnvironmentType.CondaEnv
        : IEnvironmentType.VirtualEnv;
    const envName = `${EnvironmentTypeName[envType]}: ${envInfo.name}`;

    return {
      path: pythonPath,
      type: envType,
      name: envName,
      versions: envInfo.versions
    };
  }

  setDefaultPythonPath(pythonPath: string): void {
    this._defaultEnv = this.getEnvironmentByPath(pythonPath);
  }

  getCurrentPythonEnvironment(): IPythonEnvironment {
    return this._defaultEnv;
  }

  getAdditionalPathIncludesForPythonPath(pythonPath: string): string {
    const platform = process.platform;

    let envPath = path.dirname(pythonPath);
    if (platform !== 'win32') {
      envPath = path.normalize(path.join(envPath, '../'));
    }

    let pathEnv = '';
    if (platform === 'win32') {
      pathEnv = `${envPath};${envPath}\\Library\\mingw-w64\\bin;${envPath}\\Library\\usr\\bin;${envPath}\\Library\\bin;${envPath}\\Scripts;${envPath}\\bin;${process.env['PATH']}`;
    } else {
      pathEnv = `${envPath}:${envPath}/bin:${process.env['PATH']}`;
    }

    return pathEnv;
  }

  getRequirements(): Registry.IRequirement[] {
    return this._requirements;
  }

  getRunningServerList(): Promise<string[]> {
    return new Promise<string[]>(resolve => {
      if (this._defaultEnv) {
        this._runPythonModuleCommand(this._defaultEnv.path, 'jupyter', [
          'server',
          'list',
          '--json'
        ])
          .then(async output => {
            const runningServers: string[] = [];
            const lines = output.split('\n');
            for (const line of lines) {
              const jsonStart = line.indexOf('{');
              if (jsonStart !== -1) {
                const jsonStr = line.substring(jsonStart);
                try {
                  const jsonData = JSON.parse(jsonStr);
                  // check if server is really up
                  if (await isPortInUse(jsonData.port)) {
                    runningServers.push(
                      `${jsonData.url}lab?token=${jsonData.token}`
                    );
                  }
                } catch (error) {
                  console.error(
                    `Failed to parse running JupyterLab server list`,
                    error
                  );
                }
              }
            }

            resolve(runningServers);
          })
          .catch(reason => {
            console.debug(
              `Failed to get running JupyterLab server list`,
              reason
            );
            resolve([]);
          });
      } else {
        resolve([]);
      }
    });
  }

  private _updateEnvironments() {
    this._environments = [
      ...this._discoveredEnvironments,
      ...this._userSetEnvironments
    ];
    appData.discoveredPythonEnvs = JSON.parse(
      JSON.stringify(this._discoveredEnvironments)
    );
    appData.userSetPythonEnvs = JSON.parse(
      JSON.stringify(this._userSetEnvironments)
    );
  }

  private async _loadPathEnvironments(): Promise<IPythonEnvironment[]> {
    const pythonExecutableName =
      process.platform === 'win32' ? 'python.exe' : 'python';

    const pythonInstances = [
      this._getExecutableInstances(pythonExecutableName, process.env.PATH)
    ];

    if (process.platform === 'darwin') {
      pythonInstances.push(
        this._getExecutableInstances('python3', process.env.PATH)
      );
    }

    const flattenedPythonPaths: Promise<string[]> = Promise.all(
      pythonInstances
    ).then<string[]>(multiplePythons => {
      return Array.prototype.concat.apply([], multiplePythons);
    });

    const pythonPaths = await flattenedPythonPaths;

    return pythonPaths.map((pythonPath, index) => {
      let newPythonEnvironment: IPythonEnvironment = {
        name: `${basename(pythonPath)}-${index}`,
        path: pythonPath,
        type: IEnvironmentType.Path,
        versions: {}
      };

      return newPythonEnvironment;
    });
  }

  private async _loadCondaEnvironments(): Promise<IPythonEnvironment[]> {
    const pathCondas = this._getPathCondas();
    const commonCondas = Promise.resolve(
      Registry.COMMON_CONDA_LOCATIONS.filter(condaPath =>
        this._pathExistsSync(condaPath)
      )
    );

    const allCondas = [pathCondas, commonCondas];

    // add bundled conda env to the list of base conda envs
    const bundledEnvPath = getBundledPythonEnvPath();
    if (fs.existsSync(path.join(bundledEnvPath, 'condabin'))) {
      allCondas.unshift(Promise.resolve([bundledEnvPath]));
    }

    if (process.platform === 'win32') {
      allCondas.push(this._getWindowsRegistryCondas());
    }

    const rootEnvs = await this._loadRootCondaEnvironments(allCondas);
    const subEnvs = rootEnvs.reduce<Promise<IPythonEnvironment[]>[]>(
      (accum, currentRootEnv, index, self) => {
        let rootSubEnvsFolderPath: string;
        if (process.platform === 'win32') {
          rootSubEnvsFolderPath = normalize(join(currentRootEnv.path, '..'));
        } else {
          rootSubEnvsFolderPath = normalize(
            join(currentRootEnv.path, '..', '..')
          );
        }

        accum.push(this._getSubEnvironmentsFromRoot(rootSubEnvsFolderPath));

        return accum;
      },
      []
    );
    const subEnvsResolved = await Promise.all(subEnvs);
    let flattenSubEnvs = Array.prototype.concat.apply(
      [],
      subEnvsResolved
    ) as IPythonEnvironment[];
    return rootEnvs.concat(flattenSubEnvs);
  }

  private _getSubEnvironmentsFromRoot(
    rootPath: string
  ): Promise<IPythonEnvironment[]> {
    let subEnvironmentsFolder = join(rootPath, 'envs');
    let rootName = basename(rootPath);

    return new Promise((resolve, reject) => {
      if (!fs.existsSync(subEnvironmentsFolder)) {
        console.warn('No sub-environments in root: ' + rootPath);
        return resolve([]);
      }
      fs.readdir(subEnvironmentsFolder, (err, files) => {
        if (err) {
          reject(err);
        } else {
          let subEnvsWithPython = files
            .map(subEnvPath => {
              return join(subEnvironmentsFolder, subEnvPath, 'bin', 'python');
            })
            .filter(pythonPath => this._pathExists(pythonPath));

          resolve(
            subEnvsWithPython.map(subEnvPath => {
              return {
                name: `${rootName}-${basename(
                  normalize(join(subEnvPath, '..', '..'))
                )}`,
                path: subEnvPath,
                type: IEnvironmentType.CondaEnv,
                versions: {}
              } as IPythonEnvironment;
            })
          );
        }
      });
    });
  }

  private async _loadRootCondaEnvironments(
    condaRoots: Promise<string[]>[]
  ): Promise<IPythonEnvironment[]> {
    const allCondas = await Promise.all(condaRoots);
    const flattenedCondaRoots: string[] = Array.prototype.concat.apply(
      [],
      allCondas
    );
    const uniqueCondaRoots = this._getUniqueObjects(flattenedCondaRoots);

    return uniqueCondaRoots.map(condaRootPath => {
      let path: string;
      if (process.platform === 'win32') {
        path = join(condaRootPath, 'python.exe');
      } else {
        path = join(condaRootPath, 'bin', 'python');
      }

      let newRootEnvironment: IPythonEnvironment = {
        name: basename(condaRootPath),
        path: path,
        type: IEnvironmentType.CondaRoot,
        versions: {}
      };

      return newRootEnvironment;
    });
  }

  private async _getPathCondas(): Promise<string[]> {
    const PATH = process.env.PATH;
    const condasInPath = await this._getExecutableInstances('conda', PATH);

    return await Promise.all(
      condasInPath.map(async condaExecutablePath => {
        const condaInfoOutput = this._runCommand(condaExecutablePath, [
          'info',
          '--json'
        ]);
        const condaInfoJSON = await this._convertExecutableOutputFromJson(
          condaInfoOutput
        );
        return condaInfoJSON.root_prefix as string;
      })
    );
  }

  private _getWindowsRegistryCondas(): Promise<string[]> {
    let valuePredicate = (value: any) => {
      return value.name === '(Default)';
    };

    return this._getAllMatchingValuesFromSubRegistry(
      WinRegistry.HKCU,
      '\\SOFTWARE\\Python\\ContinuumAnalytics',
      'InstallPath',
      valuePredicate
    );
  }

  private async _loadWindowsRegistryEnvironments(
    requirements: Registry.IRequirement[]
  ): Promise<IPythonEnvironment[]> {
    const valuePredicate = (value: any) => {
      return value.name === '(Default)';
    };

    const defaultPaths = this._getAllMatchingValuesFromSubRegistry(
      WinRegistry.HKCU,
      '\\SOFTWARE\\Python\\PythonCore',
      'InstallPath',
      valuePredicate
    );

    const installPaths = await defaultPaths;

    return await Promise.all(
      installPaths.map(path => {
        const finalPath = join(path, 'python.exe');

        return {
          name: `WinReg-${basename(normalize(join(path, '..')))}`,
          path: finalPath,
          type: IEnvironmentType.WindowsReg,
          versions: {}
        } as IPythonEnvironment;
      })
    );
  }

  // This function will retrieve all subdirectories of the main registry path, and for each subdirectory(registry) it will search for the key
  // matching the subDirectory parameter and the value the passes
  private async _getAllMatchingValuesFromSubRegistry(
    registryHive: string,
    mainRegPath: string,
    subDirectory: string,
    valueFilter: (value: any) => boolean
  ): Promise<string[]> {
    const mainWinRegistry = new WinRegistry({
      hive: registryHive,
      key: mainRegPath
    });

    const getMainRegistryKeys: Promise<any[]> = new Promise(
      (resolve, reject) => {
        mainWinRegistry.keys((err: any, items: any[]) => {
          if (err) {
            reject(err);
          } else {
            resolve(items);
          }
        });
      }
    );

    const installPathValues: Promise<any[]> = getMainRegistryKeys
      .then(items => {
        return Promise.all(
          items.map(item => {
            let installPath = new WinRegistry({
              hive: registryHive,
              key: item.key + '\\' + subDirectory
            });

            let allValues: Promise<any[]> = new Promise((resolve, reject) => {
              installPath.values((err: any, values: any[]) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(values);
                }
              });
            });

            return allValues;
          })
        );
      })
      .then(nestedInstallPathValues => {
        return Array.prototype.concat.apply([], nestedInstallPathValues);
      });

    const pathValues = await installPathValues;
    return pathValues.filter(valueFilter).map(v => v.value);
  }

  private _environmentSatisfiesRequirements(
    environment: IPythonEnvironment,
    requirements: Registry.IRequirement[]
  ): boolean {
    return requirements.every((req, index, reqSelf) => {
      try {
        return semver.satisfies(
          environment.versions[req.name],
          req.versionRange
        );
      } catch (e) {
        return false;
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  private _updatePythonEnvironmentsWithRequirementVersions(
    environments: IPythonEnvironment[],
    requirements: Registry.IRequirement[]
  ): Promise<IPythonEnvironment[]> {
    let updatedEnvironments = environments.map(env => {
      // Get versions for each requirement
      let versions: Promise<[string, string]>[] = requirements.map(req => {
        let pythonOutput = this._runPythonModuleCommand(
          env.path,
          req.moduleName,
          req.commands
        );
        let versionFromOutput = this._extractVersionFromExecOutput(
          pythonOutput
        );
        return versionFromOutput
          .then<[string, string]>(version => {
            return [req.name, version];
          })
          .catch<[string, string]>(reason => {
            return [req.name, Registry.NO_MODULE_SENTINEL];
          });
      });

      // Get version for python executable
      let pythonVersion = this._extractVersionFromExecOutput(
        this._runCommand(env.path, ['--version'])
      )
        .then<[string, string]>(versionString => {
          return ['python', versionString];
        })
        .catch<[string, string]>(reason => {
          return ['python', Registry.NO_MODULE_SENTINEL];
        });
      versions.push(pythonVersion);

      return Promise.all(versions).then(versions => {
        env.versions = versions.reduce(
          (
            accum: IVersionContainer,
            current: [string, string],
            index,
            self
          ) => {
            accum[current[0]] = current[1];
            return accum;
          },
          {}
        );

        return env;
      });
    });

    return Promise.all(updatedEnvironments);
  }

  private _extractVersionFromExecOutput(
    output: Promise<string>
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      return output
        .then(output => {
          const version = this._extractVersionFromExecOutputSync(output);
          if (version === '') {
            reject(new Error(`Could not find SemVer match in output!`));
          } else {
            resolve(version);
          }
        })
        .catch(reason => {
          reject(new Error(`Command output failed: ${reason}`));
        });
    });
  }

  private _extractVersionFromExecOutputSync(output: string): string {
    let matches: string[] = [];
    let currentMatch: RegExpExecArray;
    do {
      currentMatch = Registry.SEMVER_REGEX.exec(output);
      if (currentMatch) {
        matches.push(currentMatch[0]);
      }
    } while (currentMatch);

    return matches.length === 0 ? '' : matches[0];
  }

  private _convertExecutableOutputFromJson(
    output: Promise<string>
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      output
        .then(output => {
          try {
            resolve(JSON.parse(output));
          } catch (e) {
            log.error(output);
            reject(e);
          }
        })
        .catch(reject);
    });
  }

  private _pathExists(path: string): Promise<boolean> {
    return new Promise<boolean>((res, rej) => {
      fs.access(path, fs.constants.F_OK, e => {
        res(e === undefined || e === null);
      });
    });
  }

  private _pathExistsSync(path: string): boolean {
    try {
      fs.accessSync(path, fs.constants.F_OK);
      return true;
    } catch (err) {
      return false;
    }
  }

  private _getExecutableInstances(
    executableName: string,
    path: string
  ): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      which(
        executableName,
        { all: true, path: path },
        (err: any, result: string | string[]) => {
          if (err) {
            if (err.code === 'ENOENT') {
              resolve([]);
            } else {
              reject(err);
            }
          } else {
            if (typeof result === 'string') {
              resolve([result]);
            } else {
              resolve(result);
            }
          }
        }
      );
    });
  }

  private _runPythonModuleCommand(
    pythonPath: string,
    moduleName: string,
    commands: string[]
  ): Promise<string> {
    let totalCommands = ['-m', moduleName].concat(commands);
    return new Promise<string>((resolve, reject) => {
      this._runCommand(pythonPath, totalCommands)
        .then(output => {
          let missingModuleReg = new RegExp(`No module named ${moduleName}$`);
          let commandErrorReg = new RegExp(`Error executing Jupyter command`);

          if (missingModuleReg.test(output)) {
            reject(
              new Error(
                `Python executable could not find ${moduleName} module!`
              )
            );
          } else if (commandErrorReg.test(output)) {
            reject(new Error(`Jupyter command execution failed! ${output}`));
          } else {
            resolve(output);
          }
        })
        .catch(reject);
    });
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  private _runPythonModuleCommandSync(
    pythonPath: string,
    moduleName: string,
    commands: string[]
  ): string {
    const totalCommands = ['-m', moduleName].concat(commands);
    const runOptions = {
      env: { PATH: this.getAdditionalPathIncludesForPythonPath(pythonPath) }
    };

    return this._runCommandSync(pythonPath, totalCommands, runOptions);
  }

  private async _runCommand(
    executablePath: string,
    commands: string[]
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let executableRun = execFile(executablePath, commands);
      let stdoutBufferChunks: Buffer[] = [];
      let stdoutLength = 0;
      let stderrBufferChunks: Buffer[] = [];
      let stderrLength = 0;

      executableRun.stdout.on('data', chunk => {
        if (typeof chunk === 'string') {
          let newBuffer = Buffer.from(chunk);
          stdoutLength += newBuffer.length;
          stdoutBufferChunks.push(newBuffer);
        } else {
          stdoutLength += chunk.length;
          stdoutBufferChunks.push(chunk);
        }
      });

      executableRun.stderr.on('data', chunk => {
        if (typeof chunk === 'string') {
          let newBuffer = Buffer.from(chunk);
          stderrLength += newBuffer.length;
          stderrBufferChunks.push(Buffer.from(newBuffer));
        } else {
          stderrLength += chunk.length;
          stderrBufferChunks.push(chunk);
        }
      });

      executableRun.on('close', () => {
        executableRun.removeAllListeners();

        let stdoutOutput = Buffer.concat(
          stdoutBufferChunks,
          stdoutLength
        ).toString();
        let stderrOutput = Buffer.concat(
          stderrBufferChunks,
          stderrLength
        ).toString();

        if (stdoutOutput.length === 0) {
          if (stderrOutput.length === 0) {
            reject(
              new Error(
                `"${executablePath} ${commands.join(
                  ' '
                )}" produced no output to stdout or stderr!`
              )
            );
          } else {
            resolve(stderrOutput);
          }
        } else {
          resolve(stdoutOutput);
        }
      });
    });
  }

  private _runCommandSync(
    executablePath: string,
    commands: string[],
    options?: ExecFileOptions
  ): string {
    try {
      return execFileSync(executablePath, commands, options).toString();
    } catch (error) {
      return 'EXEC:ERROR';
    }
  }

  private _sortEnvironments(
    environments: IPythonEnvironment[],
    requirements: Registry.IRequirement[]
  ) {
    environments.sort((a, b) => {
      let typeCompareResult = this._compareEnvType(a.type, b.type);
      if (typeCompareResult !== 0) {
        return typeCompareResult;
      } else {
        let versionCompareResult = this._compareVersions(
          a.versions,
          b.versions,
          requirements
        );
        if (versionCompareResult !== 0) {
          return versionCompareResult;
        } else {
          return a.name.localeCompare(b.name);
        }
      }
    });
  }

  private _compareVersions(
    a: IVersionContainer,
    b: IVersionContainer,
    requirements: Registry.IRequirement[]
  ): number {
    let versionPairs = requirements.map(req => {
      return [a[req.name], b[req.name]];
    });

    for (let index = 0; index < requirements.length; index++) {
      let [aVersion, bVersion] = versionPairs[index];
      let result = aVersion.localeCompare(bVersion);

      if (result !== 0) {
        return result;
      }
    }

    return 0;
  }

  private _compareEnvType(a: IEnvironmentType, b: IEnvironmentType): number {
    return this._getEnvTypeValue(a) - this._getEnvTypeValue(b);
  }

  private _getEnvTypeValue(a: IEnvironmentType): number {
    switch (a) {
      case IEnvironmentType.Path:
        return 0;
      case IEnvironmentType.CondaRoot:
        return 1;
      case IEnvironmentType.WindowsReg:
        return 2;
      case IEnvironmentType.CondaEnv:
        return 3;
      default:
        return 100;
    }
  }

  // Probably pretty slow, luckily won't ever be used on many values
  private _getUniqueObjects<T, V>(arr: T[], keyFunction?: (value: T) => V) {
    if (keyFunction) {
      let mappedIndices = arr.map(keyFunction).map((keyValue, index, self) => {
        return self.indexOf(keyValue);
      });

      let filteredIndices = mappedIndices.filter(
        (mappedIndex, actualIndex, self) => {
          return mappedIndex === actualIndex;
        }
      );

      let filteredValues = filteredIndices.map(index => {
        return arr[index];
      });

      return filteredValues;
    } else {
      return arr.filter((value, index, self) => {
        return self.indexOf(value) === index;
      });
    }
  }

  private _environments: IPythonEnvironment[] = [];
  private _discoveredEnvironments: IPythonEnvironment[] = [];
  private _userSetEnvironments: IPythonEnvironment[] = [];
  private _defaultEnv: IPythonEnvironment;
  private _registryBuilt: Promise<void>;
  private _requirements: Registry.IRequirement[];
}

export namespace Registry {
  /**
   * This type represents module/executable package requirements for the python executables
   * in the registry. Each requirement should correspond to a python module that is also
   * executable via the '-m <module_name>' interface
   */
  export interface IRequirement {
    /**
     * The display name for the requirement
     */
    name: string;
    /**
     * The actual module name that will be used with the python executable
     */
    moduleName: string;
    /**
     * List of extra commands that will produce a version number for checking
     */
    commands: string[];
    /**
     * The Range of acceptable version produced by the previous commands field
     */
    versionRange: semver.Range;
  }

  export const COMMON_CONDA_LOCATIONS = [
    join(getUserHomeDir(), 'anaconda3'),
    join(getUserHomeDir(), 'anaconda'),
    join(getUserHomeDir(), 'miniconda3'),
    join(getUserHomeDir(), 'miniconda')
  ];

  // Copied from https://raw.githubusercontent.com/sindresorhus/semver-regex/master/index.js
  export const SEMVER_REGEX = /\bv?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z\-]+(?:\.[\da-z\-]+)*)?(?:\+[\da-z\-]+(?:\.[\da-z\-]+)*)?\b/gi;

  export const NO_MODULE_SENTINEL = 'NO MODULE OR VERSION FOUND';
}
