import type * as SecureStoreTypes from "expo-secure-store";

const ACCESS_TOKEN_KEY = "kc_secure_access_token";
const REFRESH_TOKEN_KEY = "kc_secure_refresh_token";

export interface TokenStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

function loadNativeSecureStore(): typeof SecureStoreTypes {
  // Static string literal preserved for Metro bundler while avoiding eager load in Node Vitest
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("expo-secure-store") as typeof SecureStoreTypes;
}

/**
 * Hardware-backed Android Keystore / iOS Keychain token storage adapter via `expo-secure-store`
 * (Architecture Section 8.9 — never stores tokens in plain AsyncStorage or SQLite).
 */
export const expoSecureTokenAdapter: TokenStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const SecureStore = loadNativeSecureStore();
    return SecureStore.getItemAsync(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    const SecureStore = loadNativeSecureStore();
    await SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async deleteItem(key: string): Promise<void> {
    const SecureStore = loadNativeSecureStore();
    await SecureStore.deleteItemAsync(key);
  },
};

export function createInMemoryTokenAdapter(): TokenStorageAdapter {
  const map = new Map<string, string>();
  return {
    async getItem(k) {
      return map.get(k) ?? null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async deleteItem(k) {
      map.delete(k);
    },
  };
}

export async function saveMobileSessionTokens(
  tokens: { accessToken: string; refreshToken: string },
  adapter: TokenStorageAdapter = expoSecureTokenAdapter
): Promise<void> {
  await adapter.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
  await adapter.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
}

export async function getMobileAccessToken(
  adapter: TokenStorageAdapter = expoSecureTokenAdapter
): Promise<string | null> {
  return adapter.getItem(ACCESS_TOKEN_KEY);
}

export async function getMobileRefreshToken(
  adapter: TokenStorageAdapter = expoSecureTokenAdapter
): Promise<string | null> {
  return adapter.getItem(REFRESH_TOKEN_KEY);
}

export async function clearMobileSessionTokens(
  adapter: TokenStorageAdapter = expoSecureTokenAdapter
): Promise<void> {
  await Promise.all([
    adapter.deleteItem(ACCESS_TOKEN_KEY),
    adapter.deleteItem(REFRESH_TOKEN_KEY),
  ]);
}
