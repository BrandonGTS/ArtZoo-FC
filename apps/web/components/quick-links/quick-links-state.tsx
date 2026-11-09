'use client';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction
} from 'react';
type QuickLinksState = {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  size: number;
  setSize: Dispatch<SetStateAction<number>>;
  activation: number;
  setActivation: Dispatch<SetStateAction<number>>;
};
const QuickLinksStateContext = createContext<QuickLinksState | null>(null);
/** One mounted root owns these transient UI values; no auth/data cache or browser persistence. */
export function QuickLinksStateProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false),
    [input, setInput] = useState(''),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [size, setSize] = useState(10),
    [activation, setActivation] = useState(0);
  useEffect(() => {
    if (!open) return;
    const resize = () => {
      setSize(Math.max(1, Math.min(10, Math.floor((window.innerHeight - 180) / 44))));
      setPage(1);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
    };
  }, [open, setPage, setSize]);
  const value = useMemo(
    () => ({
      open,
      setOpen,
      input,
      setInput,
      query,
      setQuery,
      page,
      setPage,
      size,
      setSize,
      activation,
      setActivation
    }),
    [open, input, query, page, size, activation]
  );
  return <QuickLinksStateContext.Provider value={value}>{children}</QuickLinksStateContext.Provider>;
}
export function useQuickLinksState() {
  const value = useContext(QuickLinksStateContext);
  if (!value) throw Error('QuickLinksButton requires QuickLinksStateProvider');
  return value;
}
