import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { SafetyError } from './safe-files.js';
/** Resolve runtime paths in JavaScript, without shell expansion or privileges. */
export function resolveConfig(config, homes = { stateHome: process.env['XDG_STATE_HOME'], home: homedir() }) {
    if (config.stateDir !== undefined)
        return { ...config, stateDir: config.stateDir };
    // XDG requires absolute paths; empty and relative values are ignored. Resolve
    // only this trusted runtime default; explicit config is still validated as-is.
    const stateHome = homes.stateHome && isAbsolute(homes.stateHome) ? homes.stateHome : undefined;
    if (!stateHome && !isAbsolute(homes.home)) {
        throw new SafetyError('invalid_root', 'User home must be an absolute path');
    }
    const base = stateHome ?? resolve(homes.home, '.local', 'state');
    return { ...config, stateDir: resolve(base, 'dsh-maibot-artifacts') };
}
/** Stable public diagnostics; never expose error messages containing local paths. */
export function errorCode(error) {
    if (error instanceof SafetyError)
        return error.code;
    if (error !== null && typeof error === 'object' && 'code' in error) {
        switch (error.code) {
            case 'ENOENT': return 'not_found';
            case 'ELOOP':
            case 'ENOTDIR':
            case 'EISDIR': return 'unsafe_file';
            case 'EACCES':
            case 'EPERM': return 'permission_denied';
            case 'ENAMETOOLONG':
            case 'EINVAL': return 'invalid_path';
        }
    }
    return 'local_io_failed';
}
