import { createApiClient } from './api-client';
import { NativeAppSchema, type NativeAppForm } from '../schemas/native-app';
const api = createApiClient();
const endpoint = '/internal/admin/native-apps';
export const nativeAppService = {
  async list() { return NativeAppSchema.array().parse(await api.get<unknown>(endpoint)); },
  async save(form: NativeAppForm, id?: string) {
    const { identifier, ...policy } = form;
    return NativeAppSchema.parse(id ? await api.put<unknown>(`${endpoint}/${encodeURIComponent(id)}`, policy)
      : await api.post<unknown>(endpoint, { ...policy, identifier }));
  },
  async icon(id: string, file: File | null) {
    if (file && file.size > 256 * 1024) throw new Error('Choose an image smaller than 256 KB.');
    const image = file ? await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = reject;
      reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
    }) : null;
    return NativeAppSchema.parse(await api.put<unknown>(`${endpoint}/${encodeURIComponent(id)}/icon`, { image }));
  },
};
