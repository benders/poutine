import { InstanceSection } from "./InstanceSection";
import { InvitationsSection } from "./InvitationsSection";
import { PeersSection } from "./PeersSection";
import { UsersSection } from "./UsersSection";
import { CacheSection } from "./CacheSection";
import { ActivitySection } from "./ActivitySection";

/**
 * Hub admin destination — owns the federation-side concerns: identity,
 * peers, invitations, users, library cache, activity retention.
 *
 * Sibling: `features/player-admin/PlayerAdminPage`. The two pages must
 * never co-exist on the same view — that's the structural commitment of
 * #212. Enforce with the cross-import scan test (`feature-boundaries.test.ts`).
 */
export function HubAdminPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-10">
      <section>
        <h1 className="text-xl font-bold text-text-primary mb-4">This Instance</h1>
        <InstanceSection />
      </section>

      <section>
        <h1 className="text-xl font-bold text-text-primary mb-4">Invitations</h1>
        <InvitationsSection />
      </section>

      <PeersSection />

      <UsersSection />

      <section>
        <h2 className="text-xl font-bold text-text-primary mb-4">Cache</h2>
        <CacheSection />
      </section>

      <section>
        <h2 className="text-xl font-bold text-text-primary mb-4">Activity</h2>
        <ActivitySection />
      </section>
    </div>
  );
}
