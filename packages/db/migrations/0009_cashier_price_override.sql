-- Let a cashier override a price without stopping the sale to fetch a manager.
--
-- sale.price_override existed from the start (migration 0001) but was never
-- granted to the cashier role, so it was reachable only by shift_lead, manager
-- and above. The register's own flow matched that: overriding a price required
-- a manager PIN, the same as a refund or a void.
--
-- That approval step is gone from the client now. Overriding a price is
-- checked exactly like a line discount is checked -- against the signed-in
-- cashier's own permissions, applied immediately, no second person. Granting
-- the permission here is what makes that actually usable by the person
-- ringing the sale, rather than only by someone already signed in as a
-- manager. Whoever administers roles for an organization can still revoke
-- this per org; it is a default, not a hard rule.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key = 'cashier'
  AND p.key = 'sale.price_override'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = p.key
  );
