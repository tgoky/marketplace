import { gql, useQuery } from '@apollo/client'
import { NextPageContext, NextPage } from 'next'
import { isNil } from 'ramda'
import { subDays } from 'date-fns'
import client from '../../client'
import { Marketplace, PriceChart, GetActivities } from 'src/types'
import { AnalyticsLayout } from './../../layouts/Analytics'

const SUBDOMAIN = process.env.MARKETPLACE_SUBDOMAIN

const GET_PRICE_CHART_DATA = gql`
  query GetPriceChartData(
    $auctionHouses: [PublicKey!]!
    $startDate: DateTimeUtc!
    $endDate: DateTimeUtc!
  ) {
    charts(
      auctionHouses: $auctionHouses
      startDate: $startDate
      endDate: $endDate
    ) {
      listingFloor {
        price
        date
      }
      salesAverage {
        price
        date
      }
      totalVolume {
        price
        date
      }
    }
  }
`

const GET_ACTIVITIES = gql`
  query GetActivities($auctionHouses: [PublicKey!]!) {
    activities(auctionHouses: $auctionHouses) {
      address
      metadata
      auctionHouse
      price
      createdAt
      wallets {
        address
        profile {
          handle
          profileImageUrl
        }
      }
      activityType
      nft {
        name
        image
        address
      }
    }
  }
`

export async function getServerSideProps({ req }: NextPageContext) {
  const subdomain = req?.headers['x-holaplex-subdomain'] || SUBDOMAIN

  const response = await client.query<GetMarketplace>({
    fetchPolicy: 'no-cache',
    query: gql`
      query GetMarketplacePage($subdomain: String!) {
        marketplace(subdomain: $subdomain) {
          subdomain
          name
          description
          logoUrl
          bannerUrl
          auctionHouse {
            authority
            address
          }
        }
      }
    `,
    variables: {
      subdomain,
    },
  })

  const {
    data: { marketplace },
  } = response

  if (isNil(marketplace)) {
    return {
      notFound: true,
    }
  }

  return {
    props: {
      marketplace,
    },
  }
}

interface GetMarketplaceInfo {
  marketplace: Marketplace
}

interface GetMarketplace {
  marketplace: Marketplace | null
}

export interface GetPriceChartData {
  charts: PriceChart
}

interface AnalyticsProps {
  marketplace: Marketplace
}

const startDate = subDays(new Date(), 6).toISOString()
const endDate = new Date().toISOString()

const Analytics: NextPage<AnalyticsProps> = ({ marketplace }) => {
  const priceChartQuery = useQuery<GetPriceChartData>(GET_PRICE_CHART_DATA, {
    fetchPolicy: 'network-only',
    variables: {
      auctionHouses: [marketplace.auctionHouse.address],
      startDate,
      endDate,
    },
  })

  const activitiesQuery = useQuery<GetActivities>(GET_ACTIVITIES, {
    variables: {
      auctionHouses: [marketplace.auctionHouse.address],
    },
  })

  return (
    <AnalyticsLayout
      title={<h1>{marketplace.name}</h1>}
      metaTitle={`${marketplace.name} Activity`}
      marketplace={marketplace}
      priceChartQuery={priceChartQuery}
      activitiesQuery={activitiesQuery}
    />
  )
}

export default Analytics
