/** Login Vault's public contract. No secret values in the settings view or agent events. */
export type VaultLoginView = {
  id: string;
  version: number;
  label: string;
  origin: string;
  usernameHint: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};
export type VaultState = { revision: number; items: VaultLoginView[] };
export type VaultLoginInput = {
  id?: string;
  label: string;
  origin: string;
  /** Omit on edit to keep the value; no trimming or secret read-back. */
  username?: string;
  password?: string;
  enabled: boolean;
};
