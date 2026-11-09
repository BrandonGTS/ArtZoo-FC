/** Official mainland-China world list, checked 2026-10-13T15:09:54.502828Z.
 * https://ff.web.sdo.com/web8/index.html#/servers
 * https://ff14act.web.sdo.com/api/serverStatus/getServerStatus
 * The API provides names, not stable numeric IDs or a publication timestamp.
 * Character-creation restrictions do not exclude an existing character's world.
 */
export const GAME_SERVER_SOURCE = {
  url: 'https://ff14act.web.sdo.com/api/serverStatus/getServerStatus',
  page: 'https://ff.web.sdo.com/web8/index.html#/servers',
  checkedAt: '2026-10-13T15:09:54.502828Z',
  sourceSha256: 'f0660ea8aa467a43e4aeec798684c8f4904ee1ec44fc009ef8ef500e7ebee023'
} as const;
export const GAME_SERVER_REGIONS: readonly { region: string; servers: readonly string[] }[] = [
  {
    region: '陆行鸟',
    servers: ['拉诺西亚', '幻影群岛', '神意之地', '萌芽池', '红玉海', '宇宙和音', '沃仙曦染', '晨曦王座']
  },
  {
    region: '莫古力',
    servers: ['潮风亭', '神拳痕', '白银乡', '白金幻象', '旅人栈桥', '拂晓之间', '龙巢神殿', '梦羽宝境']
  },
  {
    region: '猫小胖',
    servers: ['紫水栈桥', '延夏', '静语庄园', '摩杜纳', '海猫茶屋', '柔风海湾', '琥珀原']
  },
  {
    region: '豆豆柴',
    servers: ['水晶塔', '银泪湖', '太阳海岸', '伊修加德', '红茶川']
  }
] as const;
