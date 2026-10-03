import { Link, useParams } from 'react-router';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';

export function FeatureAudienceGroupPage() {
  const { appId } = useParams();
  return <><PageHeader description="" title="Audience groups" /><Card className="space-y-3 p-5"><p>Audience groups are not available. No changes have been saved.</p><Link className="text-indigo-600 hover:underline" to={`/feature-flags/${encodeURIComponent(appId ?? '')}`}>Return to feature flags</Link></Card></>;
}
