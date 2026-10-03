import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function NotFoundPage({ address }: { address?: string }) {
  const params = useParams();
  const addr = address ?? params.address;
  return (
    <Card className="mx-auto mt-10 max-w-md">
      <CardHeader>
        <CardTitle>{addr ? 'Server not tracked' : 'Page not found'}</CardTitle>
        <CardDescription>{addr ? `No server tracked at ${addr}.` : 'There is nothing at this address.'}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button render={<Link to="/" />}>Back to the dashboard</Button>
      </CardContent>
    </Card>
  );
}
