import { useCallback, useState, type FormEvent } from 'react';
import { Link2, MailPlus, Users, X } from 'lucide-react';
import { api, errorMessage, ROLES, type Role, type TeamInvitation, type TeamMember } from '../api.js';
import { dateLabel, relativeTime } from '../format.js';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, useSession } from '../session.js';
import { Banner, CopyButton, EmptyState, Loading, PageHeader, StatusBadge, useResource } from '../ui.js';

/** The dashboard link a new member opens; the token is only shown to the inviter once. */
function invitationLink(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/invite/${token}`;
}

function InviteForm({ onInvited }: { onInvited: (invitation: TeamInvitation) => Promise<void> }) {
  const session = useSession();
  const roles = ROLES.filter((role) => role !== 'owner' || session.user.role === 'owner');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const invitation = await api<TeamInvitation>('/v1/dashboard/team/invitations', { method: 'POST', body: JSON.stringify({ email: email.trim(), role }) });
      setEmail(''); await onInvited(invitation);
    } catch (cause) { setError(errorMessage(cause, 'The invitation could not be created.')); }
    finally { setBusy(false); }
  };
  return (
    <form className="panel inline-form" onSubmit={(event) => void submit(event)}>
      <div><h2>Invite a member</h2><p>{ROLE_DESCRIPTIONS[role]}. The link is valid for 7 days.</p></div>
      <div className="inline-form-controls">
        <input type="email" aria-label="Email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="colleague@shop.example" maxLength={320} required />
        <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value as Role)}>{roles.map((item) => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}</select>
        <button className="primary-button" disabled={busy || !email.trim()}><MailPlus size={15} />Invite</button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
    </form>
  );
}

export function TeamPage() {
  const session = useSession();
  const load = useCallback(() => api<{ members: TeamMember[]; invitations: TeamInvitation[] }>('/v1/dashboard/team'), []);
  const { data, error, loading, reload } = useResource(load, 'The team could not be loaded.');
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const manage = session.can('team');
  const canManage = (member: TeamMember) => manage && member.id !== session.user.id && (member.role !== 'owner' || session.user.role === 'owner');

  const run = async (key: string, work: () => Promise<unknown>, fallback: string) => {
    setBusy(key); setActionError('');
    try { await work(); await reload(); }
    catch (cause) { setActionError(errorMessage(cause, fallback)); }
    finally { setBusy(''); }
  };
  const changeRole = (member: TeamMember, role: Role) => run(member.id, () => api(`/v1/dashboard/team/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ role }) }), 'The role could not be changed.');
  const toggle = (member: TeamMember) => {
    const disable = member.status === 'active';
    if (disable && !window.confirm(`Disable ${member.email}? They are signed out everywhere and can no longer sign in.`)) return;
    void run(member.id, () => api(`/v1/dashboard/team/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: disable }) }), 'The member could not be updated.');
  };
  const revoke = (invitation: TeamInvitation) => run(invitation.id, () => api(`/v1/dashboard/team/invitations/${invitation.id}`, { method: 'DELETE' }), 'The invitation could not be revoked.');

  return <>
    <PageHeader title="Team" description="Everyone who can sign in to this workspace, and what their role lets them change." />
    {(error || actionError) && <Banner tone="error" onDismiss={() => setActionError('')}>{error || actionError}</Banner>}
    {manage && <InviteForm onInvited={async (invitation) => { setLink({ email: invitation.email, url: invitationLink(invitation.token!) }); await reload(); }} />}
    {link && (
      <div className="secret-reveal">
        <div><strong>Invitation link for {link.email}</strong><p>Shown once. Send it to them directly; anyone with the link can join with this role.</p></div>
        <code>{link.url}</code>
        <CopyButton value={link.url} label="Copy link" />
      </div>
    )}
    <section className="panel">
      <div className="panel-heading"><div><h2>Members</h2><p>Roles take effect immediately, also in open sessions.</p></div><span className="panel-icon"><Users size={16} /></span></div>
      {!data ? (loading && <Loading label="Loading team…" />) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Member</th><th>Role</th><th className="hide-sm">Last sign-in</th><th>State</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {data.members.map((member) => (
                <tr key={member.id} className={member.status === 'disabled' ? 'dimmed' : undefined}>
                  <td><strong>{member.name ?? member.email}</strong>{member.name && <small>{member.email}</small>}{member.id === session.user.id && <small>You</small>}</td>
                  <td>{canManage(member) && member.status === 'active'
                    ? <select aria-label={`Role of ${member.email}`} value={member.role} disabled={busy === member.id} onChange={(event) => void changeRole(member, event.target.value as Role)}>
                        {ROLES.filter((role) => role !== 'owner' || session.user.role === 'owner').map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                      </select>
                    : ROLE_LABELS[member.role]}</td>
                  <td className="date-cell hide-sm" title={dateLabel(member.last_login_at)}>{relativeTime(member.last_login_at)}</td>
                  <td><StatusBadge status={member.status === 'active' ? 'active' : 'revoked'} label={member.status === 'active' ? 'Active' : 'Disabled'} /></td>
                  <td className="actions-cell">{canManage(member) && <button className={member.status === 'active' ? 'danger-button small' : 'secondary-button small'} disabled={busy === member.id} onClick={() => toggle(member)}>{member.status === 'active' ? 'Disable' : 'Enable'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
    <section className="panel">
      <div className="panel-heading"><div><h2>Pending invitations</h2><p>Links that have not been used yet.</p></div><span className="panel-icon"><Link2 size={16} /></span></div>
      {!data ? null : !data.invitations.length ? <EmptyState icon={<MailPlus size={18} />} title="No pending invitations">{manage ? 'Invite a colleague above.' : 'Owners and admins can invite members.'}</EmptyState> : (
        <ul className="event-list">
          {data.invitations.map((invitation) => (
            <li key={invitation.id}>
              <div><strong>{invitation.email}</strong><span>{ROLE_LABELS[invitation.role]} · invited {relativeTime(invitation.created_at)}{invitation.invited_by ? ` by ${invitation.invited_by}` : ''} · expires {relativeTime(invitation.expires_at)}</span></div>
              {manage && (invitation.role !== 'owner' || session.user.role === 'owner') && <button className="icon-button" disabled={busy === invitation.id} onClick={() => void revoke(invitation)} aria-label={`Revoke invitation for ${invitation.email}`} title="Revoke"><X size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
    </section>
    <section className="panel">
      <div className="panel-heading"><div><h2>Roles</h2><p>Everyone can see every page; roles decide who may change what.</p></div></div>
      <div className="detail-list">{ROLES.map((role) => <div className="detail-row" key={role}><span>{ROLE_LABELS[role]}</span><div>{ROLE_DESCRIPTIONS[role]}</div></div>)}</div>
    </section>
  </>;
}
