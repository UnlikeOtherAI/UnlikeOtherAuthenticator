import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// A source guard, not runtime/SQL proof. New unwrapped canonical writers must
// be reviewed instead of silently bypassing U1's revision/outbox seam.
const root = fileURLToPath(new URL('../../src/', import.meta.url));
const models = new Set([
  'user',
  'organisation',
  'team',
  'orgMember',
  'teamMember',
  'group',
  'groupMember',
  'userAvatar',
  'teamAvatar',
]);
const methods = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);
const boundaries = new Set([
  'withDirectoryMutation',
  'withDirectoryMembershipMutation',
  'withDirectoryUserMutation',
  'withDirectoryLifecycleMutation',
]);
const privateFactors = new Set([
  'lifecycle-status.service.ts:verifyLifecycleStatus',
  'twofactor-disable.service.ts:clearTwoFactor',
  'twofactor-disable.service.ts:resetTwoFactor',
  'twofactor-enroll.service.ts:enrollTwoFactorForUser',
  'twofactor-login.service.ts:verifyTwoFactorForLogin',
  'twofactor-reset.service.ts:resetTwoFaWithToken',
]);
const factorFields = new Set(['twoFaEnabled', 'twoFaSecret', 'twoFaLastAcceptedCounter']);
function files(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? entry.name === '__tests__'
          ? []
          : files(path.join(directory, entry.name))
        : entry.name.endsWith('.ts')
          ? [path.join(directory, entry.name)]
          : [],
    );
}
function scope(node: ts.Node): ts.FunctionDeclaration | undefined {
  for (let parent: ts.Node | undefined = node; parent; parent = parent.parent)
    if (ts.isFunctionDeclaration(parent)) return parent;
  return undefined;
}
function bounded(node: ts.Node, source: ts.SourceFile): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && boundaries.has(parent.expression.getText(source)))
      return true;
  }
  return false;
}
function dataFields(call: ts.CallExpression): string[] {
  const argument = call.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return ['unknown'];
  const data = argument.properties.find((property) => property.name?.getText() === 'data');
  if (!data || !ts.isPropertyAssignment(data) || !ts.isObjectLiteralExpression(data.initializer))
    return ['unknown'];
  return data.initializer.properties.map(
    (property) => property.name?.getText().replace(/^['"]|['"]$/g, '') ?? 'unknown',
  );
}
function only(fields: string[], allowed: readonly string[] | Set<string>): boolean {
  return (
    fields.length > 0 &&
    fields.every((field) => (allowed instanceof Set ? allowed.has(field) : allowed.includes(field)))
  );
}

describe('directory canonical writer coverage', () => {
  it('keeps direct canonical writes behind the declared seam or a reviewed non-directory field boundary', () => {
    const violations: string[] = [];
    let count = 0;
    for (const file of files(root)) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const basename = path.basename(file);
      const visit = (node: ts.Node) => {
        if (ts.isTaggedTemplateExpression(node)) {
          const template = node.template;
          const sql = ts.isNoSubstitutionTemplateLiteral(template)
            ? template.text
            : template.head.text +
              template.templateSpans.map((span) => span.literal.text).join(' ');
          const canonical =
            /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?(users|organisations|teams|org_members|team_members|groups|group_members|user_avatars|team_avatars)"?\b/i.test(
              sql,
            );
          const dynamic =
            ts.isTemplateExpression(template) &&
            /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s*$/i.test(template.head.text.trim());
          if ((canonical || dynamic) && !bounded(node, source)) {
            let trustedPolicyLoop = false;
            if (
              basename === 'identity-operational-sweep.service.ts' &&
              scope(node)?.name?.text === 'scrubOperatorAttribution'
            ) {
              for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
                if (ts.isForOfStatement(parent) && ts.isArrayLiteralExpression(parent.expression)) {
                  trustedPolicyLoop = parent.expression.elements.every(
                    (item) =>
                      ts.isStringLiteral(item) &&
                      ['organisations', 'teams', 'client_domains'].includes(item.text),
                  );
                }
              }
            }
            if (!trustedPolicyLoop)
              violations.push(
                `${basename}: raw canonical/dynamic writer needs a reviewed directory boundary`,
              );
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          methods.has(node.expression.name.text) &&
          ts.isPropertyAccessExpression(node.expression.expression)
        ) {
          const model = node.expression.expression.name.text;
          if (models.has(model)) {
            count += 1;
            if (!bounded(node, source)) {
              const fn = scope(node)?.name?.text ?? '<module>';
              const key = basename + ':' + fn;
              const fields = dataFields(node);
              const method = node.expression.name.text;
              const initial =
                model === 'user' &&
                method === 'create' &&
                [
                  'auth-verify-email.service.ts:verifyEmailToken',
                  'social-login.service.ts:loginWithSocialProfile',
                ].includes(key) &&
                only(fields, ['email', 'userKey', 'domain', 'passwordHash', 'name', 'avatarUrl']);
              const credential =
                model === 'user' &&
                ((key === 'auth-reset-password.service.ts:resetPasswordWithToken' &&
                  only(fields, ['passwordHash'])) ||
                  (key === 'auth-verify-email.service.ts:verifyEmailToken' &&
                    only(fields, ['email', 'domain', 'passwordHash'])) ||
                  (privateFactors.has(key) && only(fields, factorFields)));
              // These private helpers have separate caller checks below.
              const helper =
                (key === 'profile.service.ts:readOrWriteProfile' && model === 'user') ||
                key === 'entity-deletion-job.service.ts:markDeleting' ||
                (key === 'internal-admin-lifecycle.service.ts:revokeLifecycleSessions' &&
                  model === 'user' &&
                  only(fields, ['tokenVersion']));
              if (!(initial || credential || helper))
                violations.push(
                  `${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${fn} ${model}.${method}`,
                );
            }
          }
        }
        if (
          ts.isCallExpression(node) &&
          [
            'markDeleting',
            'revokeLifecycleSessions',
            'readOrWriteProfile',
            'scrubOperatorAttribution',
          ].includes(node.expression.getText(source))
        ) {
          const name = node.expression.getText(source);
          const caller = scope(node)?.name?.text;
          const readOnlyProfile = name === 'readOrWriteProfile' && node.arguments.length === 2;
          const transitivelyBound =
            name === 'revokeLifecycleSessions' &&
            caller === 'markDeleting' &&
            basename === 'entity-deletion-job.service.ts';
          if (!bounded(node, source) && !readOnlyProfile && !transitivelyBound)
            violations.push(
              `${basename}: ${caller} calls ${name} outside its prepared directory scope`,
            );
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(count).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
