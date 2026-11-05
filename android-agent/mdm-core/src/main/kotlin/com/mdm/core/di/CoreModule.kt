package com.mdm.core.di

import android.content.Context
import com.mdm.core.admin.DevicePolicyController
import com.mdm.core.admin.ProvisioningStash
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object CoreModule {

    @Provides @Singleton
    fun provideDpm(@ApplicationContext ctx: Context): DevicePolicyController =
        DevicePolicyController(ctx)

    @Provides @Singleton
    fun provideProvisioningStash(@ApplicationContext ctx: Context): ProvisioningStash =
        ProvisioningStash(ctx)
}
