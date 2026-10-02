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
  encodeLinked,
  decodeContent,
  decodeLinked,
  readContent,
  contentHashToCid,
  cidToContentHash,
} from './content';
export type { EncodedContent, DecodedContent, DecodedLinked, ContentResult, ContentFailure } from './content';

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
  approvalFor,
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

// Render escrow — one vault per board, outside `SlotSite`; the pin is all it needs from bytecode.
export {
  ESCROW_VAULT_ABI,
  ESCROW_FACTORY_ABI,
  ATTESTOR_ABI,
  buildCreateEscrowedSite,
  buildBook,
  buildRelease,
  buildClaim,
  buildApproveVault,
  buildVaultWithdrawFor,
  buildMarkDark,
  buildClearDark,
  buildSweepForeign,
  buildFundReserve,
  buildWithdrawReserve,
  readVault,
  readDeposits,
  readClaimable,
  readVaultPending,
  readVaultOf,
  readEscrowBind,
  readEscrowPolicy,
  readAttestor,
} from './escrow';
export type { EscrowParams, BuildCreateEscrowedSiteOptions, VaultState, VaultDeposit, EscrowBind } from './escrow';

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

// The chains this SDK can name, which is a longer list than the ones it has addresses for.
export { ROBINHOOD_TESTNET_CHAIN, ROBINHOOD_MAINNET_CHAIN, CHAINS, chainFor } from './chains';
export type { Chain } from './chains';

// What a board's money is: the token each chain's boards settle in, and how to read a board's own.
export {
  ROBINHOOD_MAINNET_USDG,
  ROBINHOOD_TESTNET_TUSD,
  SETTLEMENT_TOKENS,
  settlementTokenFor,
  NATIVE_CURRENCY,
  readSettlementCurrency,
} from './settlement';
export type { SettlementToken, SettlementCurrency } from './settlement';

// Deployed addresses (§7.9 — one chain at v1, deliberately).
export {
  ROBINHOOD_MAINNET,
  ROBINHOOD_TESTNET,
  ROBINHOOD_TESTNET_R2,
  ROBINHOOD_MAINNET_ESCROW,
  ESCROW_DEPLOYMENTS,
  escrowDeploymentFor,
  ROBINHOOD_TESTNET_ESCROW,
  ROBINHOOD_TESTNET_ESCROW_R1,
  DEPLOYMENTS,
  DEMO_SITE,
  DEMO_SITE_MAINNET,
  DEMO_SITES,
  demoSiteFor,
  EXAMPLE_SITES,
  SMOKE_TEST_SITE,
  DEMO_SITE_V1,
  EXAMPLE_SITES_V1,
  deploymentFor,
} from './addresses';
export type { Deployment } from './addresses';
