// Pricing — the shared math, byte-identical to Pricing.sol (§4).
export {
  BPS_DENOMINATOR,
  SECONDS_PER_WEEK,
  PricingOverflowError,
  computeTakePrice,
  computeSplit,
  computeElapsedWeeks,
  computeBuyBreakdown,
} from './pricing';
export type { TakeQuote, Split, SiteEconomics, BuyBreakdown } from './pricing';

// The ask — the reversion BASE an owner posts, not a list price (§3).
export { resolveReversionBase, askCeiling } from './pricing';

// Rent — accrual, the unaccrued remainder a buyer inherits, and the fee split (§2).
export {
  SECONDS_PER_DAY,
  MIN_RENTAL_DURATION,
  accruedOf,
  accrual,
  rentCost,
  rentSplit,
  quoteRent,
} from './rentals';
export type { Accrual, RentSplit, RentQuote } from './rentals';

// Content addressing — sha256([version][kind][payload]), the hash is the CID (§3).
export {
  SCHEME_VERSION,
  ContentKind,
  SITE_DEFINED_KIND_MIN,
  HEADER_BYTES,
  MAX_OBJECT_BYTES,
  ContentTooLargeError,
  MalformedContentError,
  encodeContent,
  encodeText,
  encodeLink,
  encodeImage,
  decodeContent,
  readContent,
  contentHashToCid,
  cidToContentHash,
} from './content';
export type { EncodedContent, DecodedContent, ContentResult, ContentFailure } from './content';

// Slot identity — keys, not ordinals (§2).
export { slotKey, slotKeys, slotTokenId, assertValidSlotKey, MAX_KEY_LENGTH, InvalidSlotKeyError } from './keys';

// Reads — one call per page, through `SlotReader` (§5, §11.4).
export {
  SLOT_SITE_ABI,
  SLOT_READER_ABI,
  RENTALS_LIB_ABI,
  SITE_EVENTS_ABI,
  readSlots,
  readSlot,
  readSlotsMulti,
  readSiteTerms,
  isTokenSettled,
  economicsFromTerms,
  readEncumbrance,
  readBuyContext,
  readRental,
  readListing,
  readAccruedRent,
  readUnaccruedRent,
  readCanEdit,
  readPendingWithdrawal,
} from './reads';
export type { SiteRef, SlotState, SiteTerms, BuyContext, Rental, Listing } from './reads';

// Writes — request objects for viem, never a wallet of our own.
export {
  SLOT_FACTORY_ABI,
  ERC20_ABI,
  DEFAULT_DEADLINE_SECS,
  DEFAULT_SLIPPAGE_BPS,
  InvalidEconomicsError,
  isNativeSettlement,
  buildBuy,
  buildBuyFrom,
  buildEdit,
  buildSetEditor,
  buildSetEditorWithSig,
  editorGrantTypedData,
  buildRegisterSlots,
  buildSetFloor,
  buildSetAvailability,
  buildWithdrawFor,
  buildCreateSite,
  // The ask (§3)
  buildSetAsk,
  // Rentals (§2)
  buildListForRent,
  buildDelist,
  buildRent,
  buildExtendRental,
  buildClaimRent,
  buildEndRental,
  // Publisher levers and the treasury
  buildSetEconomics,
  buildSetRentalTerms,
  buildSetFloorPolicy,
  buildSetBaseTokenURI,
  buildWithdrawTreasury,
  buildSweepTreasury,
  buildApproveSettlement,
} from './writes';
export type {
  CallRequest,
  BuildBuyOptions,
  BuildRentOptions,
  BuildCreateSiteOptions,
  SiteEconomicsConfig,
  SiteRentalConfig,
  SiteFloorPolicyConfig,
} from './writes';

// Site config — the file a builder edits (§0).
export {
  defineSite,
  slotFloors,
  parseFloor,
  DEFAULT_SETTLEMENT_DECIMALS,
  CONTENT_KIND_BY_NAME,
  DEFAULT_CONTENT_GATEWAY,
  InvalidSiteConfigError,
} from './config';
export type { SiteConfig, SlotDefinition, SlotDefinitionInput, SlotKindName, DefineSiteInput } from './config';

// Deployed addresses (§7.9 — one chain at v1, deliberately).
export {
  ROBINHOOD_TESTNET,
  DEPLOYMENTS,
  DEMO_SITE,
  EXAMPLE_SITES,
  SMOKE_TEST_SITE,
  DEMO_SITE_V1,
  EXAMPLE_SITES_V1,
  deploymentFor,
} from './addresses';
export type { Deployment } from './addresses';
