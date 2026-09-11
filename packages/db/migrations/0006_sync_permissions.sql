-- =============================================================================
-- 0006_sync_permissions.sql
--
-- Three permissions the Phase 1 API needs and 0001 did not define.
--
-- `product.view` is the gap that matters most. 0001 defined product.create,
-- product.update, product.delete, product.bulk_update, product.view_cost and
-- product.view_margin, but nothing for plain read. Every role that can edit a
-- product could therefore read one, and no role could read without editing,
-- which makes "look at the catalog but change nothing" impossible to express.
-- Cost and margin stay separate: seeing that a vape sells for $24.99 is not the
-- same as seeing that it costs $9.85, and a cashier gets the first and not the
-- second.
--
-- `sync.upload` and `sync.download` gate the register's own endpoints. They are
-- separate because they fail differently: a register that cannot download runs
-- on a stale catalog, which is inconvenient, while a register that cannot
-- upload accumulates completed sales it can never hand over, which is the one
-- outcome this whole system is built to prevent. Being able to suspend one
-- without the other matters when a device is suspected stolen.
-- =============================================================================

INSERT INTO permissions (key, category, description) VALUES
  ('product.view',   'catalog',  'View products, variants and prices'),
  ('sync.upload',    'register', 'Upload sales and movements from a register'),
  ('sync.download',  'register', 'Download catalog, price and rule changes')
ON CONFLICT (key) DO NOTHING;

-- Anyone who could already edit the catalog can obviously read it.
INSERT INTO role_permissions (role_id, permission_key)
SELECT DISTINCT rp.role_id, 'product.view'
FROM role_permissions rp
WHERE rp.permission_key IN ('product.create', 'product.update', 'product.bulk_update')
ON CONFLICT DO NOTHING;

-- Cashiers read the catalog: they ring from it. They do not see cost.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key IN ('cashier', 'shift_lead')
  AND p.key IN ('product.view', 'sync.upload', 'sync.download')
ON CONFLICT DO NOTHING;

-- Every role that operates or oversees a register needs both sync directions.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key IN ('owner', 'administrator', 'manager', 'inventory_manager')
  AND p.key IN ('product.view', 'sync.upload', 'sync.download')
ON CONFLICT DO NOTHING;
