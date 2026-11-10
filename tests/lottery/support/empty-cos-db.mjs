// 替身：图片存储在读写前会先查 COS 位置记录。新站只用本地存储，这里让查询一律返回"没有 COS 记录"，
// 存储层就会回退到本地磁盘。（阶段 4 删除 COS 代码后，这个替身可以一起删掉。）
export * from '../../../packages/db/src/index.ts';
const empty = { $queryRaw: async () => [], $transaction: async (fn) => fn(empty) };
export function getDatabase() {
  return empty;
}
