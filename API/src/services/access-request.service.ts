export type { AccessRequestRecord } from './access-request.service.base.js';
export { handlePostAuthenticationAccessRequest } from './access-request.service.auth.js';
export {
  approveAccessRequest,
  listAccessRequests,
  rejectAccessRequest,
} from './access-request.service.admin.js';
