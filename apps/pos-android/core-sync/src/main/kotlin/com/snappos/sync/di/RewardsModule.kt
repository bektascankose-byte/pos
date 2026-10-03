package com.snappos.sync.di

import com.snappos.sync.RewardsGateway
import com.snappos.sync.RewardsRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/** The customer screen's rewards flow asks for the gateway; this is the real one. */
@Module
@InstallIn(SingletonComponent::class)
abstract class RewardsModule {
  @Binds
  abstract fun rewardsGateway(repository: RewardsRepository): RewardsGateway
}
