'use client';

import { useReducer, useState, type Dispatch, type SetStateAction } from 'react';

export type TeamOperationState<Operation> = {
  op: Operation | null;
  busy: boolean;
  retryAvailable: boolean;
};
export type TeamOperationAction<Operation> =
  | { field: 'op'; value: SetStateAction<Operation | null> }
  | { field: 'busy'; value: SetStateAction<boolean> }
  | { field: 'retryAvailable'; value: SetStateAction<boolean> };

function apply<T>(previous: T, value: SetStateAction<T>): T {
  return typeof value === 'function' ? (value as (previous: T) => T)(previous) : value;
}

/** Only field updates: request ordering, refs and business decisions stay in the workspace. */
export function teamOperationReducer<Operation>(
  state: TeamOperationState<Operation>,
  action: TeamOperationAction<Operation>
): TeamOperationState<Operation> {
  switch (action.field) {
    case 'op': {
      const op = apply(state.op, action.value);
      return Object.is(op, state.op) ? state : { ...state, op };
    }
    case 'busy': {
      const busy = apply(state.busy, action.value);
      return Object.is(busy, state.busy) ? state : { ...state, busy };
    }
    case 'retryAvailable': {
      const retryAvailable = apply(state.retryAvailable, action.value);
      return Object.is(retryAvailable, state.retryAvailable) ? state : { ...state, retryAvailable };
    }
  }
}

export function useTeamOperationState<Operation>() {
  const [state, dispatch] = useReducer(teamOperationReducer<Operation>, {
    op: null,
    busy: false,
    retryAvailable: false
  });
  const [setters] = useState<{
    setOp: Dispatch<SetStateAction<Operation | null>>;
    setBusy: Dispatch<SetStateAction<boolean>>;
    setRetryAvailable: Dispatch<SetStateAction<boolean>>;
  }>(() => ({
    setOp: (value) => dispatch({ field: 'op', value }),
    setBusy: (value) => dispatch({ field: 'busy', value }),
    setRetryAvailable: (value) => dispatch({ field: 'retryAvailable', value })
  }));
  return [
    state.op,
    setters.setOp,
    state.busy,
    setters.setBusy,
    state.retryAvailable,
    setters.setRetryAvailable
  ] as const;
}
