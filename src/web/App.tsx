import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { PageContainer, PageShell, RouteError } from '@/components/layout/PageShell';
import { DashboardPage } from '@/pages/DashboardPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ServerPage } from '@/pages/ServerPage';

const router = createBrowserRouter([
  {
    path: '/',
    Component: PageShell,
    errorElement: <RouteError />,
    children: [
      { index: true, Component: DashboardPage },
      {
        path: 'server/:address',
        element: (
          <PageContainer>
            <ServerPage />
          </PageContainer>
        ),
      },
      {
        path: '*',
        element: (
          <PageContainer>
            <NotFoundPage />
          </PageContainer>
        ),
      },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
