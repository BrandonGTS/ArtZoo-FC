'use client';
import { createContext, useCallback, useContext } from 'react';
import { useFeedbackMessage } from '../use-feedback-message';
const ActivityEditFeedback = createContext<(() => void) | null>(null);
// Mounted in the persistent app shell so navigation cannot remove this notice.
export function ActivityEditFeedbackProvider({ children }: { children: React.ReactNode }) {
  const { contextHolder, notify } = useFeedbackMessage();
  const saved = useCallback(() => notify('success', '活动修改成功'), [notify]);
  return (
    <ActivityEditFeedback.Provider value={saved}>
      {contextHolder}
      {children}
    </ActivityEditFeedback.Provider>
  );
}
export function useActivityEditFeedback() {
  const value = useContext(ActivityEditFeedback);
  if (!value) throw new Error('ActivityEditFeedbackProvider is required');
  return value;
}
