import type {ReactNode} from 'react';
import {useTheme} from '../../hooks/use-theme.js';
import {LanguageSelector} from './LanguageSelector.js';
import {Card} from '../ui/Card.js';
import {Logo} from '../ui/Logo.js';
export function EnterpriseActionLayout({title,children,showLanguageSelector=true}:{title:string;children:ReactNode;showLanguageSelector?:boolean}) {
  const {classNames}=useTheme();
  return <div className={classNames.appShell}><main className={classNames.pageContainer}>
    <div className={classNames.logoWrap}><Logo/></div>{showLanguageSelector && <LanguageSelector/>}
    <Card><div className="space-y-5"><h1 className="text-2xl font-semibold">{title}</h1>{children}</div></Card>
  </main></div>;
}
