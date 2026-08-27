import { Link as RouterLink } from 'react-router-dom';
import type { ReactNode } from 'react';

interface AppLinkProps {
  url?: string;
  children?: ReactNode;
  external?: boolean;
  [key: string]: unknown;
}

/**
 * Bridges Polaris' `linkComponent` to React Router so every Polaris link
 * (nav items, buttons with `url`, etc.) does client-side navigation.
 * Absolute/external URLs fall back to a plain anchor.
 */
export function AppLink({ url = '', children, external, ...rest }: AppLinkProps) {
  const isExternal = external || /^(https?:)?\/\//.test(url) || url.startsWith('mailto:');

  if (isExternal) {
    return (
      <a
        href={url}
        {...rest}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    );
  }

  return (
    <RouterLink to={url} {...rest}>
      {children}
    </RouterLink>
  );
}
