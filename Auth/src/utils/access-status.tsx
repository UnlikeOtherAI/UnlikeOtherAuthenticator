import { createContext, useContext } from 'react';

// Supplied only by the API runtime bootstrap, independently of signed product configuration.
export const AccessStatusContext = createContext(false);

export function useAccessStatusEnabled(): boolean {
  return useContext(AccessStatusContext);
}
