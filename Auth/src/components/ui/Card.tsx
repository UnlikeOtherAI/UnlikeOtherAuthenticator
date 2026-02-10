import React from 'react';

import { useTheme } from '../../hooks/use-theme.js';

export function Card(props: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const { classNames } = useTheme();
  const merged = props.className ? `${classNames.card} ${props.className}` : classNames.card;
  return <div className={merged}>{props.children}</div>;
}

