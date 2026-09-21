import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import { createSeedState } from './loadSeed';
import type { SandboxAction, SandboxState } from './types';
import { sandboxReducer } from './reducer';

const STORAGE_KEY = 'murikah.assurance-os.sandbox.v2';

function readPersisted(): SandboxState {
  if (typeof window === 'undefined') return createSeedState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createSeedState();
    const parsed = JSON.parse(raw) as SandboxState;
    if (parsed.version !== 2) return createSeedState();
    return parsed;
  } catch {
    return createSeedState();
  }
}

const SandboxContext = createContext<{ state: SandboxState; dispatch: Dispatch<SandboxAction>; reset: () => void } | null>(null);

export function SandboxProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sandboxReducer, undefined, readPersisted);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const value = useMemo(() => ({
    state,
    dispatch,
    reset: () => {
      const seeded = createSeedState();
      window.localStorage.removeItem(STORAGE_KEY);
      dispatch({ type: 'RESET', state: seeded });
    },
  }), [state]);

  return <SandboxContext.Provider value={value}>{children}</SandboxContext.Provider>;
}

export function useSandbox() {
  const value = useContext(SandboxContext);
  if (!value) throw new Error('useSandbox must be used inside SandboxProvider');
  return value;
}

export { STORAGE_KEY };
