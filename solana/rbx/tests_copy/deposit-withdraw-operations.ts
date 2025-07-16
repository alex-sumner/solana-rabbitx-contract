import { assert, expect } from "chai";
import { BN } from "bn.js";
import {
    PublicKey,
    SystemProgram,
    LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    getOrCreateAssociatedTokenAccount
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import {
    program,
    provider,
    admin,
    user,
    statePda,
    tokenAuthPda,
    solAccountPda,
    signerWallet,
    setupAccounts,
    loadState
} from "./common-setup.ts";
import {
    signWithdrawal,
    fetchStateAccount,
    getVerifyingContractFromProgram
} from "./utils.ts";

describe("deposit and withdrawal operations", () => {
    // Variables to use in this test file
    let mint: PublicKey;
    let userTokenAccount: PublicKey;

    before(async () => {
        // Try to load state from previous test execution
        const state = loadState();

        if (!state.mint || !state.userTokenAccount) {
            console.error("Required mint or userTokenAccount not found. Make sure to run basic-setup.ts first.");
            throw new Error("Required setup not completed");
        }

        mint = state.mint;
        userTokenAccount = state.userTokenAccount;
        console.log("Using mint:", mint.toString());
        console.log("Using user token account:", userTokenAccount.toString());
    });

    it("Deposits tokens", async () => {
        console.log("Testing token deposit...");

        // Get the program's token account address
        // This needs to follow the ATA derivation path
        const programTokenAccount = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin, // payer
            mint,
            tokenAuthPda,
            true // allowOwnerOffCurve
        ).then(account => account.address);

        console.log("Program token account:", programTokenAccount.toString());

        // Get initial balances
        const userTokenInfo = await provider.connection.getTokenAccountBalance(userTokenAccount);
        const initialUserBalance = parseInt(userTokenInfo.value.amount);
        console.log("Initial user token balance:", initialUserBalance / 10 ** 6);

        // Check if program token account exists
        let initialProgramBalance = 0;
        try {
            const programTokenInfo = await provider.connection.getTokenAccountBalance(programTokenAccount);
            initialProgramBalance = parseInt(programTokenInfo.value.amount);
            console.log("Initial program token balance:", initialProgramBalance / 10 ** 6);
        } catch (e) {
            console.log("Program token account doesn't exist yet or has no balance");
        }

        // Deposit amount
        const depositAmount = new BN(1_000_000); // 1 token

        try {
            // Call the deposit_token instruction
            const tx = await program.methods
                .depositToken(depositAmount)
                .accounts({
                    state: statePda,
                    mint: mint,
                    programTokenAccount: programTokenAccount,
                    programTokenAuthority: tokenAuthPda,
                    userTokenAccount: userTokenAccount,
                    user: user.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([user])
                .rpc();

            console.log("Token deposit successful! Transaction signature:", tx);

            // Check balances after deposit
            const userTokenInfoAfter = await provider.connection.getTokenAccountBalance(userTokenAccount);
            const finalUserBalance = parseInt(userTokenInfoAfter.value.amount);
            console.log("Final user token balance:", finalUserBalance / 10 ** 6);

            const programTokenInfoAfter = await provider.connection.getTokenAccountBalance(programTokenAccount);
            const finalProgramBalance = parseInt(programTokenInfoAfter.value.amount);
            console.log("Final program token balance:", finalProgramBalance / 10 ** 6);

            // Verify the deposit was successful
            expect(finalUserBalance).to.equal(initialUserBalance - depositAmount.toNumber());
            expect(finalProgramBalance).to.equal(initialProgramBalance + depositAmount.toNumber());
        } catch (e) {
            console.error("Error depositing tokens:", e);
            throw e;
        }
    });

    it("Deposits native SOL", async () => {
        console.log("Testing native SOL deposit...");

        // Get initial balances
        const initialUserBalance = await provider.connection.getBalance(user.publicKey);
        console.log("Initial user SOL balance:", initialUserBalance / LAMPORTS_PER_SOL);

        const initialProgramBalance = await provider.connection.getBalance(solAccountPda);
        console.log("Initial program SOL balance:", initialProgramBalance / LAMPORTS_PER_SOL);

        // Deposit amount
        const depositAmount = new BN(1_000_000_000); // 1 SOL

        try {
            // Call the deposit_sol instruction
            const tx = await program.methods
                .depositSol(depositAmount)
                .accounts({
                    state: statePda,
                    programSolAccount: solAccountPda,
                    user: user.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .signers([user])
                .rpc();

            console.log("SOL deposit successful! Transaction signature:", tx);

            // Check balances after deposit
            const finalUserBalance = await provider.connection.getBalance(user.publicKey);
            console.log("Final user SOL balance:", finalUserBalance / LAMPORTS_PER_SOL);

            const finalProgramBalance = await provider.connection.getBalance(solAccountPda);
            console.log("Final program SOL balance:", finalProgramBalance / LAMPORTS_PER_SOL);

            // Verify the deposit was successful - accounting for transaction fees
            expect(finalUserBalance).to.be.lessThan(initialUserBalance - depositAmount.toNumber());
            expect(finalProgramBalance).to.equal(initialProgramBalance + depositAmount.toNumber());
        } catch (e) {
            console.error("Error depositing SOL:", e);
            throw e;
        }
    });

    it("Performs a token withdrawal with valid signature", async () => {
        console.log("Testing token withdrawal...");

        // Get the program's token account address
        const programTokenAccount = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin,
            mint,
            tokenAuthPda,
            true
        ).then(account => account.address);

        // Get initial balances
        const userTokenInfo = await provider.connection.getTokenAccountBalance(userTokenAccount);
        const initialUserBalance = parseInt(userTokenInfo.value.amount);
        console.log("Initial user token balance:", initialUserBalance / 10 ** 6);

        const programTokenInfo = await provider.connection.getTokenAccountBalance(programTokenAccount);
        const initialProgramBalance = parseInt(programTokenInfo.value.amount);
        console.log("Initial program token balance:", initialProgramBalance / 10 ** 6);

        // Get the state account to get the deposit ID
        const state = await fetchStateAccount(program, statePda);
        console.log("Current deposit ID:", state.nextDepositNum.toString());

        // Get the verifying contract to use for signing
        const verifyingContractHex = await getVerifyingContractFromProgram(program, statePda);
        console.log("Verifying contract from program:", verifyingContractHex);

        // Amount to withdraw
        const withdrawAmount = new BN(500_000); // 0.5 tokens

        // Use the user's deposit ID
        const depositId = state.nextDepositNum.toNumber() - 1; // Use the previous deposit ID
        console.log("Using deposit ID:", depositId);

        // Sign the withdrawal
        const sig = await signWithdrawal(
            signerWallet,
            statePda,
            {
                id: depositId,
                token: mint,
                trader: user.publicKey,
                amount: withdrawAmount.toString(),
            }
        );

        try {
            // Call the withdraw_token instruction
            const tx = await program.methods
                .withdrawToken(depositId, withdrawAmount, sig.v, Array.from(sig.r), Array.from(sig.s))
                .accounts({
                    state: statePda,
                    mint: mint,
                    programTokenAccount: programTokenAccount,
                    programTokenAuthority: tokenAuthPda,
                    userTokenAccount: userTokenAccount,
                    user: user.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();

            console.log("Token withdrawal successful! Transaction signature:", tx);

            // Check balances after withdrawal
            const userTokenInfoAfter = await provider.connection.getTokenAccountBalance(userTokenAccount);
            const finalUserBalance = parseInt(userTokenInfoAfter.value.amount);
            console.log("Final user token balance:", finalUserBalance / 10 ** 6);

            const programTokenInfoAfter = await provider.connection.getTokenAccountBalance(programTokenAccount);
            const finalProgramBalance = parseInt(programTokenInfoAfter.value.amount);
            console.log("Final program token balance:", finalProgramBalance / 10 ** 6);

            // Verify the withdrawal was successful
            expect(finalUserBalance).to.equal(initialUserBalance + withdrawAmount.toNumber());
            expect(finalProgramBalance).to.equal(initialProgramBalance - withdrawAmount.toNumber());
        } catch (e) {
            console.error("Error withdrawing tokens:", e);
            throw e;
        }
    });

    it("Fails token withdrawal with invalid signature", async () => {
        console.log("Testing token withdrawal with invalid signature...");

        // Get the program's token account address
        const programTokenAccount = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin,
            mint,
            tokenAuthPda,
            true
        ).then(account => account.address);

        // Get the state account to get the deposit ID
        const state = await fetchStateAccount(program, statePda);

        // Amount to withdraw
        const withdrawAmount = new BN(100_000); // 0.1 tokens

        // Use the user's deposit ID
        const depositId = state.nextDepositNum.toNumber() - 1;

        try {
            // Use an invalid signature by passing incorrect values
            const invalidSig = {
                v: 28, // Valid value but wrong for this message
                r: Buffer.from("0000000000000000000000000000000000000000000000000000000000000000", "hex"),
                s: Buffer.from("0000000000000000000000000000000000000000000000000000000000000000", "hex")
            };

            // Call the withdraw_token instruction with invalid signature
            await program.methods
                .withdrawToken(depositId, withdrawAmount, invalidSig.v, Array.from(invalidSig.r), Array.from(invalidSig.s))
                .accounts({
                    state: statePda,
                    mint: mint,
                    programTokenAccount: programTokenAccount,
                    programTokenAuthority: tokenAuthPda,
                    userTokenAccount: userTokenAccount,
                    user: user.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();

            // If we get here, the test failed because the invalid signature was accepted
            assert.fail("Withdrawal with invalid signature should have been rejected");
        } catch (e) {
            console.log("Withdrawal with invalid signature failed as expected with error:", e.message);
            // Verify we get the expected error for invalid signature
            assert.include(e.message, "InvalidSignature", "Error should be InvalidSignature error");
        }
    });

    it("Performs a SOL withdrawal with valid signature", async () => {
        console.log("Testing SOL withdrawal...");

        // Get initial balances
        const initialUserBalance = await provider.connection.getBalance(user.publicKey);
        console.log("Initial user SOL balance:", initialUserBalance / LAMPORTS_PER_SOL);

        const initialProgramBalance = await provider.connection.getBalance(solAccountPda);
        console.log("Initial program SOL balance:", initialProgramBalance / LAMPORTS_PER_SOL);

        // Get the state account to get the deposit ID
        const state = await fetchStateAccount(program, statePda);
        console.log("Current deposit ID:", state.nextDepositNum.toString());

        // Amount to withdraw - 0.5 SOL
        const withdrawAmount = new BN(500_000_000);

        // Use the user's deposit ID
        const depositId = state.nextDepositNum.toNumber() - 1; // Use the previous deposit ID
        console.log("Using deposit ID:", depositId);

        // Get the wrapped SOL mint address
        const wrappedSolMint = new PublicKey("So11111111111111111111111111111111111111112");

        // Sign the withdrawal
        const sig = await signWithdrawal(
            signerWallet,
            statePda,
            {
                id: depositId,
                token: wrappedSolMint,
                trader: user.publicKey,
                amount: withdrawAmount.toString(),
            }
        );

        try {
            // Call the withdraw_sol instruction
            const tx = await program.methods
                .withdrawSol(depositId, withdrawAmount, sig.v, Array.from(sig.r), Array.from(sig.s))
                .accounts({
                    state: statePda,
                    programSolAccount: solAccountPda,
                    user: user.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .signers([user])
                .rpc();

            console.log("SOL withdrawal successful! Transaction signature:", tx);

            // Check balances after withdrawal
            const finalUserBalance = await provider.connection.getBalance(user.publicKey);
            console.log("Final user SOL balance:", finalUserBalance / LAMPORTS_PER_SOL);

            const finalProgramBalance = await provider.connection.getBalance(solAccountPda);
            console.log("Final program SOL balance:", finalProgramBalance / LAMPORTS_PER_SOL);

            // Verify the withdrawal was successful
            expect(finalUserBalance).to.be.greaterThan(initialUserBalance); // Account for tx fees
            expect(finalProgramBalance).to.equal(initialProgramBalance - withdrawAmount.toNumber());
        } catch (e) {
            console.error("Error withdrawing SOL:", e);
            throw e;
        }
    });
}); 