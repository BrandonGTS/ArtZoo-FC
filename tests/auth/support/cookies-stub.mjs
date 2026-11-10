// Only imported by http-quota.test.mjs via a file-local module hook.
export async function cookies() {
  return {
    get() {
      return undefined;
    }
  };
}
