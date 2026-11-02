import type { BuildStamp } from '../src/pi/observer/types.ts';
export function hashBytes(value: string | Buffer): string;
export function canonicalHash(value: unknown): string;
export function allowedManifestPath(path: string): boolean;
export function readVerifiedFile(root: string, path: string, expectedHash?: string, maxBytes?: number): { bytes: Buffer; hash: string };
export function createManifest(root: string, paths: string[], options?: { gitRevision?: string | null; dirty?: boolean | null; buildId?: string }): BuildStamp;
export function trackedManifest(root: string, options?: { buildId?: string; manifestPath?: string }): BuildStamp;
export function verifyManifest(root: string, manifest: BuildStamp): BuildStamp;

export function validateManifest(manifest: BuildStamp): BuildStamp;
