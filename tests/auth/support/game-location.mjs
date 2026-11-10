import { GAME_SERVER_REGIONS } from '../../../packages/domain/src/account-contract.ts';
const first = GAME_SERVER_REGIONS[0];
export const location = { gameRegion: first.region, gameServer: first.servers[0] };
export const otherLocation = { gameRegion: first.region, gameServer: first.servers[1] };
export const otherRegionLocation = {
  gameRegion: GAME_SERVER_REGIONS[1].region,
  gameServer: GAME_SERVER_REGIONS[1].servers[0]
};
