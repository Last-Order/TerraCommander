import { useCallback, useRef, useState } from 'react';
import type { DirectoryViewportCommand, DirectoryViewportRequest } from './directory-types';

export function useDirectoryViewportCommand() {
  const sequenceRef = useRef(0);
  const [command, setCommand] = useState<DirectoryViewportCommand | null>(null);

  const request = useCallback(
    ({ locator, align = 'auto', focus = false }: DirectoryViewportRequest) => {
      sequenceRef.current += 1;
      setCommand({
        seq: sequenceRef.current,
        locator,
        align,
        focus,
      });
    },
    [],
  );

  const clear = useCallback((seq: number) => {
    setCommand((current) => (current?.seq === seq ? null : current));
  }, []);

  return {
    command,
    request,
    clear,
  };
}
