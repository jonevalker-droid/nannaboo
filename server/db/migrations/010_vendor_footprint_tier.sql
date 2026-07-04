-- 010: admin-configurable vendor "footprint" tier — screen-space prominence
-- (icon size / styling / stacking priority) in the multi-target AR view.
--
-- STRUCTURAL SAFETY GUARANTEE: the tier can only ever exist on the 'vendor'
-- category. Safety POIs (exit, medic, restroom — and every other non-vendor
-- category) are constrained to a NULL tier at the schema level, so no API or
-- UI path can promote or demote their prominence. Do not relax this to an
-- application-level check.

ALTER TABLE poi ADD COLUMN footprint_tier text
  CHECK (footprint_tier IN ('standard', 'featured', 'premium'));

ALTER TABLE poi ADD CONSTRAINT poi_footprint_vendor_only
  CHECK (footprint_tier IS NULL OR category = 'vendor');
