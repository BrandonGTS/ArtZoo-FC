import type { CatalogDutyType, DutyCatalogEntry, DutyCatalogList } from '@artzoo/domain';
import { DUTY_CATALOG_DATA, DUTY_CATALOG_VERSION } from '@artzoo/domain';

// Keep reads behind this interface so persistence can change without changing publication.
// Version and entry travel together to prevent mismatched revision snapshots.
export interface DutyCatalogReader {
  list(query?: { type?: CatalogDutyType; search?: string }): Promise<DutyCatalogList>;
  findById(id: string): Promise<{ catalogVersion: string; entry: DutyCatalogEntry } | null>;
}
export const staticDutyCatalog: DutyCatalogReader = {
  async list(query = {}) {
    const search = query.search?.trim().toLocaleLowerCase() ?? '';
    return {
      catalogVersion: DUTY_CATALOG_VERSION,
      items: structuredClone(
        DUTY_CATALOG_DATA.filter(
          (entry) =>
            entry.enabled &&
            (!query.type || entry.type === query.type) &&
            (!search || entry.name.toLocaleLowerCase().includes(search))
        )
      )
    };
  },
  async findById(id) {
    const entry = DUTY_CATALOG_DATA.find((item) => item.id === id);
    return entry ? { catalogVersion: DUTY_CATALOG_VERSION, entry: structuredClone(entry) } : null;
  }
};
