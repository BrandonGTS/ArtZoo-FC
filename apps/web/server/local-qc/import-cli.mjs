import { assertQcCliContext } from './core.ts';
assertQcCliContext({
  argv: process.argv.slice(2),
  stdinTTY: Boolean(process.stdin.isTTY),
  stdoutTTY: Boolean(process.stdout.isTTY),
  environment: process.env
});
const { getDatabase } = await import('@artzoo/db');
const { assertQcTransaction, preflightQcAccounts } = await import('./core.ts');
const { readHiddenLine } = await import('./hidden-input.ts');
const { importLocalQcData } = await import('./data.ts');
const db = getDatabase();
try {
  const state = await preflightQcAccounts(db);
  if (!state.bindings) throw Error('accounts missing');
  await db.$transaction((tx) => assertQcTransaction(tx, { bindings: state.bindings, requireAdmin: true }));
  const originalDirectory = process.env.ARTZOO_PHOTO_ORIGINAL_DIR;
  const derivedDirectory = process.env.ARTZOO_PHOTO_DERIVED_DIR;
  if (!originalDirectory || !derivedDirectory) throw Error('Explicit deployed media directories required');
  console.log('目标：家庭本地 localhost:3100 / artzoo_dev；仅追加[虚构QC-V1]样本。');
  console.log('包括7条新账号站内消息、内部合成几何图片和1条纯文字公开精选；无真实外发、官方活动或公开照片。');
  console.log('固定首跑时刻，48小时人工QC窗口；重复运行不延期、不重建，用户修改会使整次导入停止。');
  const confirmation = await readHiddenLine('确认追加以上虚构样本：输入 IMPORT_LOCAL_QC_SAMPLES：', {
    maxLength: 60,
    accepts: /^[A-Z_]$/
  });
  if (confirmation !== 'IMPORT_LOCAL_QC_SAMPLES') throw Error('cancelled');
  const result = await importLocalQcData(db, state.bindings, { originalDirectory, derivedDirectory });
  console.log(JSON.stringify(result));
} catch (error) {
  // Media failures can leave only newly-created staged bytes. Preserve exact receipts for manual review.
  const { LocalQcDataError } = await import('./data-contract.ts');
  if (error instanceof LocalQcDataError)
    console.error(JSON.stringify({ code: error.code, slots: error.slots, files: error.files }));
  else console.error('导入停止：目标、安全前检、账号授权或现有状态不符。未覆盖旧数据；不自动清理媒体。');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
