import { NextPage, NextPageContext } from 'next'
import { AppProps } from 'next/app'
import { gql } from '@apollo/client'
import {
  isNil,
  pipe,
  ifElse,
  or,
  always,
  equals,
  length,
  find,
  prop,
  isEmpty,
  filter,
  and,
  not,
  concat,
  all,
  map,
  any,
  gt,
  intersection,
  partialRight,
} from 'ramda'
import Head from 'next/head'
import cx from 'classnames'
import client from '../../client'
import { useRouter } from 'next/router'
import { useQuery } from '@apollo/client'
import { Link } from 'react-router-dom'
import WalletPortal from '../../components/WalletPortal'
import Button, { ButtonType } from '../../components/Button'
import { Route, Routes } from 'react-router-dom'
import OfferPage from '../../components/Offer'
import SellNftPage from '../../components/SellNft'
import Avatar from '../../components/Avatar'
import {
  truncateAddress,
  collectionNameByAddress,
  howrareisJSONByAddress,
  moonrankJSONByAddress,
} from '../../modules/address'

import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { AuctionHouseProgram } from '@metaplex-foundation/mpl-auction-house'
import { MetadataProgram } from '@metaplex-foundation/mpl-token-metadata'
import { format } from 'timeago.js'
import {
  Transaction,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js'
import { toSOL } from '../../modules/lamports'
import { toast } from 'react-toastify'
import { useForm } from 'react-hook-form'
import CancelOfferForm from '../../components/CancelOfferForm'
import AcceptOfferForm from '../../components/AcceptOfferForm'
import { useLogin } from '../../hooks/login'
import { Marketplace, Nft, Listing, Offer, Activity } from '../../types.d'
import { DollarSign, Tag } from 'react-feather'

const SUBDOMAIN = process.env.MARKETPLACE_SUBDOMAIN

const {
  createPublicBuyInstruction,
  createExecuteSaleInstruction,
  createCancelInstruction,
  createPrintBidReceiptInstruction,
  createCancelListingReceiptInstruction,
  createPrintPurchaseReceiptInstruction,
} = AuctionHouseProgram.instructions

const pickAuctionHouse = prop('auctionHouse')

const moreThanOne = pipe(length, partialRight(gt, [1]))

const GET_NFT = gql`
  query GetNft($address: String!) {
    nft(address: $address) {
      name
      address
      image(width: 1400)
      sellerFeeBasisPoints
      mintAddress
      description
      owner {
        address
        associatedTokenAccountAddress
      }
      attributes {
        traitType
        value
      }
      creators {
        address
      }
      offers {
        address
        tradeState
        price
        buyer
        createdAt
        auctionHouse
      }
      activities {
        address
        metadata
        auctionHouse
        price
        createdAt
        wallets
        activityType
      }
      listings {
        address
        auctionHouse
        bookkeeper
        seller
        metadata
        purchaseReceipt
        price
        tokenSize
        bump
        tradeState
        tradeStateBump
        createdAt
        canceledAt
      }
    }
  }
`

export async function getServerSideProps({ req, query }: NextPageContext) {
  const subdomain = req?.headers['x-holaplex-subdomain']

  const {
    data: { marketplace, nft },
  } = await client.query<GetNftPage>({
    fetchPolicy: 'no-cache',
    query: gql`
      query GetNftPage($subdomain: String!, $address: String!) {
        marketplace(subdomain: $subdomain) {
          subdomain
          name
          description
          logoUrl
          bannerUrl
          ownerAddress
          creators {
            creatorAddress
            storeConfigAddress
          }
          auctionHouse {
            address
            treasuryMint
            auctionHouseTreasury
            treasuryWithdrawalDestination
            feeWithdrawalDestination
            authority
            creator
            auctionHouseFeeAccount
            bump
            treasuryBump
            feePayerBump
            sellerFeeBasisPoints
            requiresSignOff
            canChangeSalePrice
          }
        }
        nft(address: $address) {
          address
          mintAddress
          image
          name
          description
          creators {
            address
          }
        }
      }
    `,
    variables: {
      subdomain: subdomain || SUBDOMAIN,
      address: query?.address,
    },
  })

  const nftCreatorAddresses = map(prop('address'))(nft?.creators || [])
  const marketplaceCreatorAddresses = map(prop('creatorAddress'))(
    marketplace?.creators || []
  )
  const notAllowed = pipe(
    intersection(marketplaceCreatorAddresses),
    isEmpty
  )(nftCreatorAddresses)

  if (or(any(isNil)([marketplace, nft]), notAllowed)) {
    return {
      notFound: true,
    }
  }

  return {
    props: {
      marketplace,
      nft,
    },
  }
}

interface GetNftPage {
  marketplace: Marketplace | null
  nft: Nft | null
}

interface NftPageProps extends AppProps {
  marketplace: Marketplace
  nft: Nft
}

interface GetNftData {
  nft: Nft
}

const NftShow: NextPage<NftPageProps> = ({ marketplace, nft }) => {
  const { publicKey, signTransaction, connected, connecting } = useWallet()
  const { connection } = useConnection()
  const router = useRouter()
  const cancelListingForm = useForm()
  const buyNowForm = useForm()

  const { data, loading, refetch } = useQuery<GetNftData>(GET_NFT, {
    variables: {
      address: router.query?.address,
    },
  })

  const isMarketplaceAuctionHouse = equals(marketplace.auctionHouse.address)
  const isOwner = equals(data?.nft.owner.address, publicKey?.toBase58()) || null
  const login = useLogin()
  const listing = find<Listing>(
    pipe(pickAuctionHouse, isMarketplaceAuctionHouse)
  )(data?.nft.listings || [])
  const offers = filter<Offer>(
    pipe(pickAuctionHouse, isMarketplaceAuctionHouse)
  )(data?.nft.offers || [])
  const offer = find<Offer>(pipe(prop('buyer'), equals(publicKey?.toBase58())))(
    data?.nft.offers || []
  )
  let activities = filter<Activity>(
    pipe(pickAuctionHouse, isMarketplaceAuctionHouse)
  )(data?.nft.activities || [])

  const moonrank = moonrankJSONByAddress(data?.nft.creators[0].address)
  const howrareis = howrareisJSONByAddress(data?.nft.creators[0].address)

  const buyNftTransaction = async () => {
    if (!publicKey || !signTransaction) {
      login()
      return
    }

    if (!listing || isOwner || !data) {
      return
    }

    const auctionHouse = new PublicKey(marketplace.auctionHouse.address)
    const authority = new PublicKey(marketplace.auctionHouse.authority)
    const auctionHouseFeeAccount = new PublicKey(
      marketplace.auctionHouse.auctionHouseFeeAccount
    )
    const treasuryMint = new PublicKey(marketplace.auctionHouse.treasuryMint)
    const seller = new PublicKey(listing.seller)
    const tokenMint = new PublicKey(data?.nft.mintAddress)
    const auctionHouseTreasury = new PublicKey(
      marketplace.auctionHouse.auctionHouseTreasury
    )
    const listingReceipt = new PublicKey(listing.address)
    const sellerPaymentReceiptAccount = new PublicKey(listing.seller)
    const sellerTradeState = new PublicKey(listing.tradeState)
    const buyerPrice = listing.price.toNumber()
    const tokenAccount = new PublicKey(
      data?.nft.owner.associatedTokenAccountAddress
    )

    const [metadata] = await MetadataProgram.findMetadataAccount(tokenMint)

    const [escrowPaymentAccount, escrowPaymentBump] =
      await AuctionHouseProgram.findEscrowPaymentAccountAddress(
        auctionHouse,
        publicKey
      )

    const [buyerTradeState, tradeStateBump] =
      await AuctionHouseProgram.findPublicBidTradeStateAddress(
        publicKey,
        auctionHouse,
        treasuryMint,
        tokenMint,
        buyerPrice,
        1
      )
    const [freeTradeState, freeTradeStateBump] =
      await AuctionHouseProgram.findTradeStateAddress(
        seller,
        auctionHouse,
        tokenAccount,
        treasuryMint,
        tokenMint,
        0,
        1
      )
    const [programAsSigner, programAsSignerBump] =
      await AuctionHouseProgram.findAuctionHouseProgramAsSignerAddress()
    const [buyerReceiptTokenAccount] =
      await AuctionHouseProgram.findAssociatedTokenAccountAddress(
        tokenMint,
        publicKey
      )

    const [bidReceipt, bidReceiptBump] =
      await AuctionHouseProgram.findBidReceiptAddress(buyerTradeState)
    const [purchaseReceipt, purchaseReceiptBump] =
      await AuctionHouseProgram.findPurchaseReceiptAddress(
        sellerTradeState,
        buyerTradeState
      )

    const publicBuyInstructionAccounts = {
      wallet: publicKey,
      paymentAccount: publicKey,
      transferAuthority: publicKey,
      treasuryMint,
      tokenAccount,
      metadata,
      escrowPaymentAccount,
      authority,
      auctionHouse,
      auctionHouseFeeAccount,
      buyerTradeState,
    }
    const publicBuyInstructionArgs = {
      tradeStateBump,
      escrowPaymentBump,
      buyerPrice,
      tokenSize: 1,
    }

    const executeSaleInstructionAccounts = {
      buyer: publicKey,
      seller,
      tokenAccount,
      tokenMint,
      metadata,
      treasuryMint,
      escrowPaymentAccount,
      sellerPaymentReceiptAccount,
      buyerReceiptTokenAccount,
      authority,
      auctionHouse,
      auctionHouseFeeAccount,
      auctionHouseTreasury,
      buyerTradeState,
      sellerTradeState,
      freeTradeState,
      programAsSigner,
    }

    const executeSaleInstructionArgs = {
      escrowPaymentBump,
      freeTradeStateBump,
      programAsSignerBump,
      buyerPrice,
      tokenSize: 1,
    }

    const printBidReceiptAccounts = {
      bookkeeper: publicKey,
      receipt: bidReceipt,
      instruction: SYSVAR_INSTRUCTIONS_PUBKEY,
    }
    const printBidReceiptArgs = {
      receiptBump: bidReceiptBump,
    }

    const printPurchaseReceiptAccounts = {
      bookkeeper: publicKey,
      purchaseReceipt,
      bidReceipt,
      listingReceipt,
      instruction: SYSVAR_INSTRUCTIONS_PUBKEY,
    }
    const printPurchaseReceiptArgs = {
      purchaseReceiptBump,
    }

    const publicBuyInstruction = createPublicBuyInstruction(
      publicBuyInstructionAccounts,
      publicBuyInstructionArgs
    )
    const printBidReceiptInstruction = createPrintBidReceiptInstruction(
      printBidReceiptAccounts,
      printBidReceiptArgs
    )
    const executeSaleInstruction = createExecuteSaleInstruction(
      executeSaleInstructionAccounts,
      executeSaleInstructionArgs
    )
    const printPurchaseReceiptInstruction =
      createPrintPurchaseReceiptInstruction(
        printPurchaseReceiptAccounts,
        printPurchaseReceiptArgs
      )

    const txt = new Transaction()

    txt
      .add(publicBuyInstruction)
      .add(printBidReceiptInstruction)
      .add(
        new TransactionInstruction({
          programId: AuctionHouseProgram.PUBKEY,
          data: executeSaleInstruction.data,
          keys: concat(
            executeSaleInstruction.keys,
            data?.nft.creators.map((creator) => ({
              pubkey: new PublicKey(creator.address),
              isSigner: false,
              isWritable: true,
            }))
          ),
        })
      )
      .add(printPurchaseReceiptInstruction)

    txt.recentBlockhash = (await connection.getRecentBlockhash()).blockhash
    txt.feePayer = publicKey

    let signed: Transaction | undefined = undefined

    try {
      signed = await signTransaction(txt)
    } catch (e: any) {
      toast.error(e.message)
      return
    }

    let signature: string | undefined = undefined

    try {
      toast('Sending the transaction to Solana.')

      signature = await connection.sendRawTransaction(signed.serialize())

      await connection.confirmTransaction(signature, 'confirmed')

      await refetch()

      toast.success('The transaction was confirmed.')
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const cancelListingTransaction = async () => {
    if (!publicKey || !signTransaction) {
      login()
      return
    }

    if (!listing || !isOwner || !data) {
      return
    }

    const auctionHouse = new PublicKey(marketplace.auctionHouse.address)
    const authority = new PublicKey(marketplace.auctionHouse.authority)
    const auctionHouseFeeAccount = new PublicKey(
      marketplace.auctionHouse.auctionHouseFeeAccount
    )
    const tokenMint = new PublicKey(data?.nft.mintAddress)
    const treasuryMint = new PublicKey(marketplace.auctionHouse.treasuryMint)
    const receipt = new PublicKey(listing.address)
    const tokenAccount = new PublicKey(
      data?.nft.owner.associatedTokenAccountAddress
    )

    const buyerPrice = listing.price.toNumber()

    const [tradeState] = await AuctionHouseProgram.findTradeStateAddress(
      publicKey,
      auctionHouse,
      tokenAccount,
      treasuryMint,
      tokenMint,
      buyerPrice,
      1
    )

    const cancelInstructionAccounts = {
      wallet: publicKey,
      tokenAccount,
      tokenMint,
      authority,
      auctionHouse,
      auctionHouseFeeAccount,
      tradeState,
    }
    const cancelInstructionArgs = {
      buyerPrice,
      tokenSize: 1,
    }

    const cancelListingReceiptAccounts = {
      receipt,
      instruction: SYSVAR_INSTRUCTIONS_PUBKEY,
    }

    const cancelInstruction = createCancelInstruction(
      cancelInstructionAccounts,
      cancelInstructionArgs
    )
    const cancelListingReceiptInstruction =
      createCancelListingReceiptInstruction(cancelListingReceiptAccounts)

    const txt = new Transaction()

    txt.add(cancelInstruction).add(cancelListingReceiptInstruction)

    txt.recentBlockhash = (await connection.getRecentBlockhash()).blockhash
    txt.feePayer = publicKey

    let signed: Transaction | undefined = undefined

    try {
      signed = await signTransaction(txt)
    } catch (e: any) {
      toast.error(e.message)
      return
    }

    let signature: string | undefined = undefined

    try {
      toast('Sending the transaction to Solana.')

      signature = await connection.sendRawTransaction(signed.serialize())

      await connection.confirmTransaction(signature, 'confirmed')

      await refetch()

      toast.success('The transaction was confirmed.')
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const rankingsOwnersBlock = (
    <div className="flex w-full justify-evenly align-middle">
      <div className="w-1/2">
        <div className="mt-6 label">OWNED BY</div>
        <div className="mt-1">
          <a
            href={`https://holaplex.com/profiles/${data?.nft.owner.address}`}
            rel="noreferrer"
            target="_blank"
          >
            <Avatar
              name={truncateAddress(data?.nft.owner.address || '')}
              className="font-mono text-sm"
            />
          </a>
        </div>
      </div>
      <div className="w-1/2">
        <div className="mt-6 label">RANKINGS</div>
        <div className="flex space-x-2">
          {moonrank && moonrank[nft.mintAddress] && (
            <a
              href={'https://moonrank.app/' + nft.mintAddress}
              target="_blank"
              className="flex items-center justify-end space-x-2 sm:space-x-2"
            >
              <span className="text-[#6ef600] mb-1 select-none font-extrabold">
                ⍜
              </span>
              <span className="text-sm">{moonrank[nft.mintAddress]}</span>
            </a>
          )}
          {howrareis && howrareis[nft.mintAddress] && (
            <a
              href={'https://howrare.is/' + nft.mintAddress}
              target="_blank"
              className="flex items-center justify-end space-x-1"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                viewBox="0 0 44 44"
              >
                <g transform="translate(0 -3)">
                  <path
                    d="M30.611,28.053A6.852,6.852,0,0,0,33.694,25.3a7.762,7.762,0,0,0,1.059-4.013,7.3,7.3,0,0,0-2.117-5.382q-2.118-2.153-6.2-2.153h-4.86V11.52H15.841v2.233H12.48v5.259h3.361v4.92H12.48v5.013h3.361V36.48h5.737V28.945h3.387l3.989,7.535H35.52Zm-2.056-5.32a2.308,2.308,0,0,1-2.393,1.2H21.578v-4.92h4.8a2.074,2.074,0,0,1,2.178,1.153,2.611,2.611,0,0,1,0,2.568"
                    fill="#6ef600"
                  ></path>
                </g>
              </svg>
              <span className="text-sm">{howrareis[nft.mintAddress]}</span>
            </a>
          )}
        </div>
      </div>
    </div>
  )

  const collectionLink = (address: string) => (
    <h3 className="mb-4 text-lg">
      <a href={`/collections/${address}`} className="text-[#6ff600]">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-6 w-6 inline-block mr-1 -mt-1"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        </svg>
        {collectionNameByAddress(address)}
      </a>
    </h3>
  )

  return (
    <>
      <Head>
        <title>
          {truncateAddress(router.query?.address as string)} NFT |{' '}
          {marketplace.name}
        </title>
        <link rel="icon" href={marketplace.logoUrl} />
        <link rel="stylesheet" href="https://use.typekit.net/nxe8kpf.css" />
        <meta property="og:site_name" content={marketplace.name} />
        <meta
          property="og:title"
          content={`${nft.name} | ${marketplace.name}`}
        />
        <meta property="og:image" content={nft.image} />
        <meta property="og:description" content={nft.description} />
      </Head>
      <div className="sticky top-0 z-10 flex items-center justify-between p-6 text-white bg-gray-900/80 backdrop-blur-md grow">
        <Link to="/">
          <button className="flex items-center justify-between gap-2 bg-gray-800 rounded-full align sm:px-4 sm:py-2 sm:h-14 hover:bg-gray-600 transition-transform hover:scale-[1.02]">
            <img
              className="object-cover w-12 h-12 md:w-8 md:h-8 rounded-full aspect-square"
              src={marketplace.logoUrl}
            />
            <div className="hidden sm:block">{marketplace.name}</div>
          </button>
        </Link>
        <div className="block">
          <div className="flex items-center justify-end">
            {equals(
              publicKey?.toBase58(),
              marketplace.auctionHouse.authority
            ) && (
              <Link
                to="/admin/marketplace/edit"
                className="text-sm cursor-pointer mr-6 hover:underline "
              >
                Admin Dashboard
              </Link>
            )}
            <WalletPortal />
          </div>
        </div>
      </div>
      <div className="container px-4 pb-10 mx-auto text-white">
        <div className="grid items-start grid-cols-1 gap-6 mt-12 mb-10 lg:grid-cols-2">
          <div className="block mb-4 lg:mb-0 lg:flex lg:items-center lg:justify-center ">
            <div className="block mb-6 lg:hidden">
              {loading ? (
                <div className="w-full h-32 bg-gray-800 rounded-lg" />
              ) : (
                <>
                  <h1 className="mb-4 text-2xl">{data?.nft.name}</h1>
                  {collectionLink(data?.nft.creators[0].address)}
                  <p className="text-lg mb-2">{data?.nft.description}</p>
                  {rankingsOwnersBlock}
                </>
              )}
            </div>
            {loading ? (
              <div className="w-full bg-gray-800 border-none rounded-lg aspect-square" />
            ) : (
              <img
                src={data?.nft.image}
                className="block h-auto w-full border-none rounded-lg shadow"
              />
            )}
          </div>
          <div>
            <div className="hidden mb-4 lg:block">
              {loading ? (
                <div className="w-full h-32 bg-gray-800 rounded-lg" />
              ) : (
                <>
                  <h1 className="mb-4 text-2xl">{data?.nft.name}</h1>
                  {collectionLink(data?.nft.creators[0].address)}
                  <p className="text-lg mb-2">{data?.nft.description}</p>
                  {rankingsOwnersBlock}
                </>
              )}
            </div>

            <div
              className={cx('w-full p-6 mt-8 bg-gray-800 rounded-lg', {
                'h-44': loading,
              })}
            >
              <div
                className={cx('flex', {
                  hidden: loading,
                })}
              >
                {listing && (
                  <div className="flex-1 mb-6">
                    <div className="label">PRICE</div>
                    <p className="text-base md:text-xl">
                      <b className="sol-amount">
                        {toSOL(listing.price.toNumber())}
                      </b>
                    </p>
                  </div>
                )}
              </div>
              <div className={cx('flex gap-4', { hidden: loading })}>
                <Routes>
                  <Route
                    path={`/nfts/${data?.nft.address}`}
                    element={
                      <>
                        {listing && !isOwner && (
                          <form
                            className="flex-1"
                            onSubmit={buyNowForm.handleSubmit(
                              buyNftTransaction
                            )}
                          >
                            <Button
                              loading={buyNowForm.formState.isSubmitting}
                              htmlType="submit"
                              block
                              className="bg-[#6ff600]"
                            >
                              Buy Now
                            </Button>
                          </form>
                        )}
                        {!isOwner && !offer && (
                          <Link
                            to={`/nfts/${data?.nft.address}/offers/new`}
                            className="flex-1"
                          >
                            <Button type={ButtonType.Secondary} block>
                              Make Offer
                            </Button>
                          </Link>
                        )}
                        {isOwner && !listing && (
                          <Link
                            to={`/nfts/${data?.nft.address}/listings/new`}
                            className="flex-1"
                          >
                            <Button block>Sell NFT</Button>
                          </Link>
                        )}
                        {listing && isOwner && (
                          <form
                            className="flex-1"
                            onSubmit={cancelListingForm.handleSubmit(
                              cancelListingTransaction
                            )}
                          >
                            <Button
                              block
                              loading={cancelListingForm.formState.isSubmitting}
                              htmlType="submit"
                              type={ButtonType.Secondary}
                            >
                              Cancel Listing
                            </Button>
                          </form>
                        )}
                      </>
                    }
                  />
                  <Route
                    path={`/nfts/${data?.nft.address}/offers/new`}
                    element={
                      <OfferPage
                        nft={data?.nft}
                        marketplace={marketplace}
                        refetch={refetch}
                      />
                    }
                  />
                  <Route
                    path={`/nfts/${data?.nft.address}/listings/new`}
                    element={
                      <SellNftPage
                        nft={data?.nft}
                        marketplace={marketplace}
                        refetch={refetch}
                      />
                    }
                  />
                </Routes>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-8">
              {loading ? (
                <>
                  <div className="h-16 bg-gray-800 rounded" />
                  <div className="h-16 bg-gray-800 rounded" />
                  <div className="h-16 bg-gray-800 rounded" />
                  <div className="h-16 bg-gray-800 rounded" />
                </>
              ) : (
                data?.nft.attributes.map((a) => (
                  <div
                    key={a.traitType}
                    className="p-3 border border-gray-700 rounded"
                  >
                    <p className="uppercase label">{a.traitType}</p>
                    <p className="truncate text-ellipsis" title={a.value}>
                      {a.value}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
        <div className="flex justify-between mt-10 mb-10 text-sm sm:text-base md:text-lg ">
          <div className="w-full">
            <h2 className="mb-4 text-xl md:text-2xl text-bold">Offers</h2>
            {ifElse(
              (offers: Offer[]) =>
                and(pipe(length, equals(0))(offers), not(loading)),
              always(
                <div className="w-full p-10 text-center border border-gray-800 rounded-lg">
                  <h3>No offers found</h3>
                  <p className="text-gray-500 mt-">
                    There are currently no offers on this NFT.
                  </p>
                </div>
              ),
              (offers: Offer[]) => (
                <section className="w-full">
                  <header
                    className={cx(
                      'grid px-4 mb-2',
                      ifElse(
                        all(isNil),
                        always('grid-cols-3'),
                        always('grid-cols-4')
                      )([offer, isOwner])
                    )}
                  >
                    <span className="label">FROM</span>
                    <span className="label">PRICE</span>
                    <span className="label">WHEN</span>
                    {any(pipe(isNil, not))([offer, isOwner]) && (
                      <span className="label"></span>
                    )}
                  </header>
                  {loading ? (
                    <>
                      <article className="bg-gray-800 mb-4 h-16 rounded" />
                      <article className="bg-gray-800 mb-4 h-16 rounded" />
                      <article className="bg-gray-800 mb-4 h-16 rounded" />
                    </>
                  ) : (
                    offers.map((o: Offer) => (
                      <article
                        key={o.address}
                        className={cx(
                          'grid p-4 mb-4 border border-gray-700 rounded',
                          ifElse(
                            all(isNil),
                            always('grid-cols-3'),
                            always('grid-cols-4')
                          )([offer, isOwner])
                        )}
                      >
                        <div>
                          <a
                            href={`https://holaplex.com/profiles/${o.buyer}`}
                            rel="nofollower"
                          >
                            {truncateAddress(o.buyer)}
                          </a>
                        </div>
                        <div>
                          <span className="sol-amount">
                            {toSOL(o.price.toNumber())}
                          </span>
                        </div>
                        <div>{format(o.createdAt, 'en_US')}</div>
                        {(offer || isOwner) && (
                          <div className="flex w-full gap-2 justify-end">
                            {equals(
                              o.buyer,
                              publicKey?.toBase58() as string
                            ) && (
                              <CancelOfferForm
                                nft={data?.nft}
                                marketplace={marketplace}
                                offer={o}
                                refetch={refetch}
                              />
                            )}
                            {isOwner && (
                              <AcceptOfferForm
                                nft={data?.nft}
                                marketplace={marketplace}
                                offer={o}
                                listing={listing}
                                refetch={refetch}
                              />
                            )}
                          </div>
                        )}
                      </article>
                    ))
                  )}
                </section>
              )
            )(offers)}

            <h2 className="mb-4 mt-14 text-xl md:text-2xl text-bold">
              Activity
            </h2>
            {ifElse(
              (activities: Activity[]) =>
                and(pipe(length, equals(0))(activities), not(loading)),
              always(
                <div className="w-full p-10 text-center border border-gray-800 rounded-lg">
                  <h3>No activities found</h3>
                  <p className="text-gray-500 mt-">
                    There are currently no activities for this NFT.
                  </p>
                </div>
              ),
              (activities: Activity[]) => (
                <section className="w-full">
                  <header className="grid px-4 mb-2 grid-cols-4">
                    <span className="label">EVENT</span>
                    <span className="label">WALLETS</span>
                    <span className="label">PRICE</span>
                    <span className="label">WHEN</span>
                  </header>
                  {loading ? (
                    <>
                      <article className="bg-gray-800 mb-4 h-16 rounded" />
                      <article className="bg-gray-800 mb-4 h-16 rounded" />
                      <article className="bg-gray-800 mb-4 h-16 rounded" />
                      <article className="bg-gray-800 mb-4 h-16 rounded" />
                    </>
                  ) : (
                    activities.map((a: Activity) => {
                      const hasWallets = moreThanOne(a.wallets)

                      return (
                        <article
                          key={a.address}
                          className="grid grid-cols-4 p-4 mb-4 border border-gray-700 rounded"
                        >
                          <div className="flex self-center">
                            {a.activityType === 'purchase' ? (
                              <DollarSign
                                className="mr-2 self-center text-gray-300"
                                size="18"
                              />
                            ) : (
                              <Tag
                                className="mr-2 self-center text-gray-300"
                                size="18"
                              />
                            )}
                            <div>
                              {a.activityType === 'purchase'
                                ? 'Sold'
                                : 'Listed'}
                            </div>
                          </div>
                          <div
                            className={cx('flex items-center self-center ', {
                              '-ml-6': hasWallets,
                            })}
                          >
                            {hasWallets && (
                              <img
                                src="/images/uturn.svg"
                                className="mr-2 text-gray-300 w-4"
                                alt="wallets"
                              />
                            )}
                            <div className="flex flex-col">
                              <a
                                href={`https://holaplex.com/profiles/${a.wallets[0]}`}
                                rel="nofollower"
                                className="text-sm"
                              >
                                {truncateAddress(a.wallets[0])}
                              </a>
                              {hasWallets && (
                                <a
                                  href={`https://holaplex.com/profiles/${a.wallets[1]}`}
                                  rel="nofollower"
                                  className="text-sm"
                                >
                                  {truncateAddress(a.wallets[1])}
                                </a>
                              )}
                            </div>
                          </div>
                          <div className="self-center">
                            <span className="sol-amount">
                              {toSOL(a.price.toNumber())}
                            </span>
                          </div>
                          <div className="self-center text-sm">
                            {format(a.createdAt, 'en_US')}
                          </div>
                        </article>
                      )
                    })
                  )}
                </section>
              )
            )(activities)}
          </div>
        </div>
      </div>
    </>
  )
}

export default NftShow
