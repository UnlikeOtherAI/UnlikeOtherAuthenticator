import { useState, type ChangeEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import { TeamAvatar } from './TeamAvatar';
import { useDeleteTeamAvatarMutation, useUploadTeamAvatarMutation } from './admin-queries';
import { useAdminUi } from '../shell/admin-ui';

/** Mirrors the server-side cap; rejecting here avoids a pointless 1 MiB+ upload round trip. */
const MAX_AVATAR_BYTES = 1024 * 1024;
const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp';

type TeamAvatarSectionProps = {
  teamId: string;
  teamName: string;
};

/**
 * Company-avatar management for one team: preview, upload (PNG/JPEG/WebP up to 1 MB), and a
 * confirmed removal that falls back to the team icon or the generated image.
 */
export function TeamAvatarSection({ teamId, teamName }: TeamAvatarSectionProps) {
  const { confirm } = useAdminUi();
  const [error, setError] = useState('');
  const upload = useUploadTeamAvatarMutation(teamId);
  const remove = useDeleteTeamAvatarMutation(teamId);
  const busy = upload.isPending || remove.isPending;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    // Clear the input so re-picking the same file after a rejection still fires a change.
    event.target.value = '';
    setError('');

    if (!file) {
      return;
    }

    if (file.size > MAX_AVATAR_BYTES) {
      setError('That image is larger than 1 MB. Choose a smaller PNG, JPEG, or WebP file.');
      return;
    }

    try {
      await upload.mutateAsync(file);
    } catch {
      setError('The image could not be uploaded. Only PNG, JPEG, and WebP files up to 1 MB are accepted.');
    }
  }

  function requestRemove() {
    setError('');
    confirm('Remove team avatar?', `${teamName} falls back to its icon or a generated image.`, async () => {
      try {
        await remove.mutateAsync();
      } catch (error) {
        setError('The avatar could not be removed. Try again.');
        throw error;
      }
    });
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Team avatar</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            Shown wherever {teamName} appears. Removing the uploaded image falls back to the team icon or a generated image.
          </p>
        </div>
        <Button size="sm" variant="danger" disabled={busy} onClick={requestRemove}>
          {remove.isPending ? 'Removing…' : 'Remove'}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <TeamAvatar label={teamName} size="md" teamId={teamId} />
        <div className="min-w-56 flex-1">
          <FieldShell label="Upload new avatar" hint="PNG, JPEG, or WebP, up to 1 MB. The image is stored as soon as it is selected.">
            <TextField accept={ACCEPTED_TYPES} disabled={busy} type="file" onChange={handleFileChange} />
          </FieldShell>
        </div>
      </div>
      {upload.isPending ? <p className="mt-2 text-xs text-gray-400">Uploading…</p> : null}
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </section>
  );
}
