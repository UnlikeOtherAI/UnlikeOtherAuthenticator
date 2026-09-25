import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { FieldShell, TextField, TextAreaField } from '../../components/ui/FormFields';
import { NativeAppFormSchema, type NativeApp, type NativeAppForm } from '../../schemas/native-app';
import { useSaveNativeApp } from './native-app-queries';

const defaults: NativeAppForm = { identifier: '', name: '', enabled: true, redirect_uris: [],
  scopes: ['openid', 'profile', 'email'], methods: ['google', 'email_password'], allow_registration: true,
  primary_color: '#2563eb', background_color: '#ffffff', text_color: '#111827' };
export function NativeAppDialog({ app, close }: { app?: NativeApp; close: () => void }) {
  const { register, handleSubmit } = useForm<NativeAppForm>({ defaultValues: app ?? defaults });
  const [redirects, setRedirects] = useState(app?.redirect_uris.join('\n') ?? '');
  const [file, setFile] = useState<File | null | undefined>(undefined);
  const [error, setError] = useState('');
  const save = useSaveNativeApp();
  async function submit(values: NativeAppForm) {
    const parsed = NativeAppFormSchema.safeParse({ ...values, redirect_uris: redirects.split('\n').map((s) => s.trim()).filter(Boolean) });
    if (!parsed.success) { setError('Check the identifier, callbacks, colors and selected login methods.'); return; }
    setError('');
    try { await save.mutateAsync({ form: parsed.data, id: app?.id, file }); close(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save this app.'); }
  }
  return <Modal isOpen onClose={close} title={app ? `Edit ${app.name}` : 'Register app'} widthClassName="max-w-xl">
    <form className="space-y-4" onSubmit={handleSubmit(submit)}>
      <FieldShell label="App name"><TextField {...register('name')} required /></FieldShell>
      <FieldShell label="App identifier" hint="Reverse-domain name, for example com.example.browser. Public; no secret is issued.">
        <TextField {...register('identifier')} readOnly={Boolean(app)} placeholder="com.example.browser" required /></FieldShell>
      <FieldShell label="Return URLs" hint="One exact callback per line. Numeric loopback callbacks allow a varying port.">
        <TextAreaField rows={3} value={redirects} onChange={(e) => setRedirects(e.target.value)} required /></FieldShell>
      <fieldset className="flex gap-5"><legend className="mb-2 text-sm font-medium">Login methods</legend>
        <label><input type="checkbox" value="google" {...register('methods')} /> Google</label>
        <label><input type="checkbox" value="email_password" {...register('methods')} /> Email and password</label>
      </fieldset>
      <label className="block text-sm"><input type="checkbox" {...register('allow_registration')} /> Allow new accounts through Google</label>
      <fieldset className="flex flex-wrap gap-3"><legend className="mb-2 text-sm font-medium">Account access</legend>
        {(['openid', 'profile', 'email', 'settings.read', 'settings.write'] as const).map((scope) =>
          <label key={scope} className="text-sm"><input type="checkbox" value={scope} {...register('scopes')} /> {scope}</label>)}
      </fieldset>
      <div className="grid grid-cols-3 gap-4">
        <FieldShell label="Accent"><TextField type="color" {...register('primary_color')} /></FieldShell>
        <FieldShell label="Background"><TextField type="color" {...register('background_color')} /></FieldShell>
        <FieldShell label="Text"><TextField type="color" {...register('text_color')} /></FieldShell>
      </div>
      <FieldShell label="App icon" hint="PNG, JPEG or WebP, up to 256 KB.">
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0])} /></FieldShell>
      {app?.icon_url && file === undefined ? <div className="flex items-center gap-3"><img src={app.icon_url} alt={app.name} className="h-12 w-12 object-contain" />
        <Button type="button" onClick={() => setFile(null)}>Remove icon</Button></div> : null}
      <label className="block text-sm"><input type="checkbox" {...register('enabled')} /> Enabled</label>
      {app ? <p className="text-xs text-gray-500">Changing login methods, account access, return URLs or enabled status requires users to sign in again.</p> : null}
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      <div className="flex justify-end gap-2"><Button type="button" onClick={close}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save app'}</Button></div>
    </form>
  </Modal>;
}
