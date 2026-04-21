import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { Button } from '../components/ui/Button';
import { adminAssets } from '../config/assets';
import { useAdminSession, useAdminSessionActions } from '../features/auth/admin-session';
import { LoginFormSchema, type LoginFormValues } from '../schemas/admin';

export function LoginPage() {
  const { isAuthenticated } = useAdminSession();
  const { signIn } = useAdminSessionActions();
  const location = useLocation();
  const navigate = useNavigate();
  const form = useForm<LoginFormValues>({
    resolver: zodResolver(LoginFormSchema),
    defaultValues: { email: 'admin@system.local', password: '', rememberDevice: false },
  });

  const from = typeof location.state === 'object' && location.state && 'from' in location.state ? String(location.state.from) : '/dashboard';

  if (isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  function submit(values: LoginFormValues) {
    const didSignIn = signIn(values.email);

    if (didSignIn) {
      navigate(from, { replace: true });
      return;
    }

    form.setError('root', { message: 'Admin session API is not configured for production builds.' });
  }

  return (
    <main className="flex min-h-full flex-col justify-center bg-slate-950 px-6 py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="flex flex-col items-center gap-3">
          <img src={adminAssets.appIcon} width="140" height="140" className="h-32 w-32 rounded-[20px]" alt="UOA" />
          <span className="text-2xl font-semibold tracking-tight text-white">UOA Admin</span>
        </div>
        <p className="mt-2 text-center text-sm text-slate-400">Unlike Other Authenticator — System Administration</p>
      </div>
      <div className="mx-auto mt-8 w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 px-6 py-8 shadow-2xl sm:px-10">
        <h1 className="mb-6 text-lg font-semibold text-slate-100">Sign in to your account</h1>
        <form className="space-y-5" onSubmit={form.handleSubmit(submit)}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-300">Admin email</span>
            <input
              {...form.register('email')}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3.5 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500"
              autoComplete="email"
              placeholder="admin@example.com"
              type="email"
            />
            {form.formState.errors.email ? <span className="mt-1 block text-xs text-red-300">{form.formState.errors.email.message}</span> : null}
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-300">Password</span>
            <input
              {...form.register('password')}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3.5 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500"
              autoComplete="current-password"
              placeholder="••••••••"
              type="password"
            />
            {form.formState.errors.password ? <span className="mt-1 block text-xs text-red-300">{form.formState.errors.password.message}</span> : null}
          </label>
          <label className="flex items-center gap-2">
            <input {...form.register('rememberDevice')} className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-600 focus:ring-indigo-500" type="checkbox" />
            <span className="text-sm text-slate-400">Remember this device</span>
          </label>
          {form.formState.errors.root ? <p className="text-sm text-red-300">{form.formState.errors.root.message}</p> : null}
          <Button className="w-full border-indigo-600 bg-indigo-600 focus:ring-offset-slate-900" icon="logout" type="submit" variant="primary">
            Sign in
          </Button>
        </form>
        <div className="mt-6 border-t border-slate-800 pt-5 text-center text-xs text-slate-500">
          <p>Access restricted to system administrators.</p>
          <p>All sessions are logged and monitored.</p>
        </div>
      </div>
      <p className="mt-6 text-center text-xs text-slate-600">Unlike Other Authenticator — Admin v1.0</p>
    </main>
  );
}
