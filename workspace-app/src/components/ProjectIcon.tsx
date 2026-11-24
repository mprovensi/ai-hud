import { useEffect, useState } from 'react';
import { FolderKanban } from 'lucide-react';
import { api } from '../api';

interface Props {
  cwd?: string;
  machine?: string;
  size?: number;
  active?: boolean;
  accent?: boolean;
}

export function ProjectIcon({ cwd, machine, size = 15, active = false, accent = false }: Props) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [cwd, machine]);

  if (!cwd || failed) {
    return (
      <FolderKanban
        size={size}
        color={active || accent ? 'var(--accent)' : 'var(--muted)'}
        style={{ flexShrink: 0 }}
      />
    );
  }

  return (
    <img
      src={api.projectIconUrl(cwd, machine)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: size,
        height: size,
        borderRadius: size >= 28 ? 7 : 4,
        objectFit: 'contain',
        flexShrink: 0,
        display: 'block',
      }}
    />
  );
}
