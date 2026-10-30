import type { ArtifactConfig } from './core.js';
interface StateHome {
    stateHome: string | undefined;
    home: string;
}
/** Resolve runtime paths in JavaScript, without shell expansion or privileges. */
export declare function resolveConfig(config: ArtifactConfig, homes?: StateHome): ArtifactConfig & {
    stateDir: string;
};
/** Stable public diagnostics; never expose error messages containing local paths. */
export declare function errorCode(error: unknown): string;
export {};
