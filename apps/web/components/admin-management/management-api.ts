'use client';
import { useEffect } from 'react';
import { useSharingCommand, useSharingResource, type SharingCommand } from '../public-sharing/sharing-api';
import { useSuperAdminScope } from './super-admin-scope';
const accessErrors = new Set(['FORBIDDEN', 'UNAUTHENTICATED']);
export function useManagementResource<T>(
  path: string | null,
  { keepPrevious = false, revalidate = true }: { keepPrevious?: boolean; revalidate?: boolean } = {}
) {
  const { ownerKey, deny } = useSuperAdminScope();
  const resource = useSharingResource<T>(path, ownerKey, keepPrevious, revalidate);
  const blocked = Boolean(resource.errorCode && accessErrors.has(resource.errorCode));
  useEffect(() => {
    if (blocked) deny();
  }, [blocked, deny]);
  return { ...resource, blocked };
}
export function useManagementCommand<T>({
  success,
  failure
}: {
  success(result: T, command: SharingCommand): void;
  failure?(code: string): void;
}) {
  const { deny } = useSuperAdminScope();
  return useSharingCommand<T>({
    success,
    failure(code) {
      if (accessErrors.has(code)) deny();
      failure?.(code);
    }
  });
}
