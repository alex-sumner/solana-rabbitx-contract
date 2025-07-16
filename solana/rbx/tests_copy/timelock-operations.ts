import { assert, expect } from "chai";
import { BN } from "bn.js";
import {
    Keypair,
    PublicKey,
    LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import {
    program,
    provider,
    statePda,
    timelockAuthority,
    setupAccounts,
    loadState
} from "./common-setup.ts";
import {
    fetchStateAccount,
    waitForTimelock,
    generateEthereumAddress
} from "./utils.ts";

describe("timelock operations", () => {
    // Variables to use in this test file if needed
    let mint: PublicKey | null = null;
    let userTokenAccount: PublicKey | null = null;

    before(async () => {
        // Make sure we have the accounts set up
        await setupAccounts();

        // Try to load state from previous test execution
        // This is not strictly necessary for timelock tests but good to have for consistency
        const state = loadState();
        if (state.mint && state.userTokenAccount) {
            mint = state.mint;
            userTokenAccount = state.userTokenAccount;
            console.log("Using mint:", mint.toString());
            console.log("Using user token account:", userTokenAccount.toString());
        }
    });

    it("queue timelock operation to add new authority", async () => {
        const newAuthority = anchor.web3.Keypair.generate();
        console.log("New authority public key:", newAuthority.publicKey.toBase58());

        const state = await fetchStateAccount(program, statePda);

        // Queue the timelock operation to add new authority
        const operationData = new PublicKey(newAuthority.publicKey).toBytes();

        await program.methods
            .queueOperation(new BN(4), Buffer.from(operationData)) // 4 = Add timelock authority
            .accounts({
                state: statePda,
                authority: timelockAuthority.publicKey,
            })
            .signers([timelockAuthority])
            .rpc();

        // Verify operation was queued
        const stateAfterQueue = await fetchStateAccount(program, statePda);
        console.log(`Pending operations: ${stateAfterQueue.pendingOperations.length}`);
        console.log(`First pending operation type: ${stateAfterQueue.pendingOperations[0]?.operationType}`);

        // Attempt to execute the operation immediately - this should fail
        try {
            await program.methods
                .executeOperation(new BN(0))
                .accounts({
                    state: statePda,
                    authority: timelockAuthority.publicKey,
                })
                .signers([timelockAuthority])
                .rpc();
            assert.fail("Immediate execution should have failed");
        } catch (e) {
            console.log("Immediate execution failed as expected with error:", e.message);
            assert.ok(e.message.includes("TimelockDelayNotMet"), "Error should be TimelockDelayNotMet");
        }

        await waitForTimelock(state);
        // Execute the operation
        await program.methods
            .executeOperation(new BN(0))
            .accounts({
                state: statePda,
                authority: timelockAuthority.publicKey,
            })
            .signers([timelockAuthority])
            .rpc();

        // Verify authority was added
        const stateAfterExecution = await fetchStateAccount(program, statePda);
        console.log("Authorities after execution:", stateAfterExecution.timelockAuthorities.map(a => a.toBase58()));

        // Verify the new authority was added
        const newAuthorityAdded = stateAfterExecution.timelockAuthorities.some(
            a => a.toBase58() === newAuthority.publicKey.toBase58()
        );

        expect(newAuthorityAdded).to.be.true;
    });

    it("queue timelock operation to update withdrawal signer", async () => {
        const newWithdrawalSigner = generateEthereumAddress();
        console.log("New withdrawal signer:", newWithdrawalSigner.toString('hex'));

        // Fetch the state account to get current withdrawal signer
        const state = await fetchStateAccount(program, statePda);
        console.log("Current withdrawal signer:", Buffer.from(state.withdrawalSigner).toString('hex'));

        // Queue the timelock operation to update withdrawal signer
        await program.methods
            .queueOperation(new BN(2), newWithdrawalSigner) // 2 = Change signer
            .accounts({
                state: statePda,
                authority: timelockAuthority.publicKey,
            })
            .signers([timelockAuthority])
            .rpc();

        // Verify operation was queued
        const stateAfterQueue = await fetchStateAccount(program, statePda);
        console.log(`Pending operations: ${stateAfterQueue.pendingOperations.length}`);

        // Find the index of the operation we just queued
        const operationIndex = stateAfterQueue.pendingOperations.findIndex(op => op.operationType === 2);
        console.log(`Found operation at index: ${operationIndex}`);

        if (operationIndex === -1) {
            throw new Error("Could not find the withdrawal signer operation in pending operations");
        }

        await waitForTimelock(state);
        // Execute the operation
        await program.methods
            .executeOperation(new BN(operationIndex))
            .accounts({
                state: statePda,
                authority: timelockAuthority.publicKey,
            })
            .signers([timelockAuthority])
            .rpc();

        const stateAfterExecution = await fetchStateAccount(program, statePda);
        console.log("Withdrawal signer after execution:", Buffer.from(stateAfterExecution.withdrawalSigner).toString('hex'));

        // Verify the new withdrawal signer was set
        expect(Buffer.from(stateAfterExecution.withdrawalSigner).toString('hex'))
            .to.equal(newWithdrawalSigner.toString('hex'));
    });

    it("Fails when unauthorized account attempts to queue withdrawal signer update", async () => {
        console.log("\n=== Testing unauthorized withdrawal signer update attempt ===");

        // Create an unauthorized account
        const unauthorizedAccount = Keypair.generate();
        console.log("Unauthorized account:", unauthorizedAccount.publicKey.toString());

        // Fund the unauthorized account
        await provider.connection.confirmTransaction(
            await provider.connection.requestAirdrop(
                unauthorizedAccount.publicKey,
                1 * LAMPORTS_PER_SOL
            )
        );

        // Generate a new withdrawal signer
        const newWithdrawalSigner = generateEthereumAddress();
        console.log("Attempting to set new withdrawal signer:", newWithdrawalSigner.toString('hex'));

        try {
            // Attempt to queue the operation with unauthorized account
            await program.methods
                .queueOperation(new BN(2), newWithdrawalSigner) // 2 = Change signer
                .accounts({
                    state: statePda,
                    authority: unauthorizedAccount.publicKey, // Using unauthorized account
                })
                .signers([unauthorizedAccount])
                .rpc();

            // If we get here, the test failed because the unauthorized operation succeeded
            assert.fail("Unauthorized account should not be able to queue withdrawal signer update");
        } catch (e) {
            console.log("Operation failed as expected with error:", e.message);
            assert.ok(
                e.message.includes("Unauthorized access"),
                "Error should indicate unauthorized access"
            );
        }

        // Verify the withdrawal signer hasn't changed
        const state = await fetchStateAccount(program, statePda);
        console.log("Current withdrawal signer:", Buffer.from(state.withdrawalSigner).toString('hex'));

        // Verify no new operations were queued
        console.log("Number of pending operations:", state.pendingOperations.length);
    });

    it("Queues a timelock operation to change the timelock delay", async () => {
        console.log("\n=== Testing timelock operations: Change Timelock Delay ===");
        console.log("Using timelock authority:", timelockAuthority.publicKey.toString());

        // Prepare data for changing timelock delay to 20 seconds
        const newDelay = 20;
        const delayBytes = new BN(newDelay).toArrayLike(Buffer, 'le', 8);

        try {
            // Queue the operation
            const tx = await program.methods
                .queueOperation(
                    new BN(3), // 3 = Set timelock delay operation type
                    Buffer.from(delayBytes)
                )
                .accounts({
                    state: statePda,
                    authority: timelockAuthority.publicKey,
                })
                .signers([timelockAuthority])
                .rpc();

            console.log("Successfully queued change timelock delay operation:", tx);

            // Get the updated state to see the pending operations
            const state = await fetchStateAccount(program, statePda);
            console.log("State account exists with size:", state.pendingOperations.length, "pending operations");
            console.log("Operation has been queued successfully");

            // Find the index of the operation we just queued
            const operationIndex = state.pendingOperations.findIndex(op => op.operationType === 3);
            console.log(`Found operation at index: ${operationIndex}`);

            // Wait for the timelock delay
            await waitForTimelock(state);

            // Execute the operation
            const execTx = await program.methods
                .executeOperation(new BN(operationIndex))
                .accounts({
                    state: statePda,
                    authority: timelockAuthority.publicKey,
                })
                .signers([timelockAuthority])
                .rpc();

            console.log("Successfully executed timelock delay change operation:", execTx);

            // Verify the timelock delay was changed
            const stateAfterExecution = await fetchStateAccount(program, statePda);
            console.log("Timelock delay after execution:", stateAfterExecution.timelockDelay.toString());
            expect(stateAfterExecution.timelockDelay.toNumber()).to.equal(newDelay);
        } catch (e) {
            console.error("Error changing timelock delay:", e);
            throw e;
        }
    });

    it("Queues and executes a timelock operation to add support for a new token", async () => {
        console.log("\n=== Testing timelock operations: Add support for a new token ===");

        // Create a new token mint for testing
        const newToken = Keypair.generate().publicKey;
        console.log("New token to support:", newToken.toString());

        // Prepare the min deposit amount - 0.5 tokens
        const minDepositAmount = new BN(500_000);

        // Prepare the operation data: token mint address + min deposit amount
        const tokenMintBytes = newToken.toBytes();
        const minDepositBytes = minDepositAmount.toArrayLike(Buffer, 'le', 8);
        const operationData = Buffer.concat([
            Buffer.from(tokenMintBytes),
            Buffer.from(minDepositBytes)
        ]);

        try {
            // Queue the operation
            const tx = await program.methods
                .queueOperation(
                    new BN(1), // 1 = Support token operation type
                    Buffer.from(operationData)
                )
                .accounts({
                    state: statePda,
                    authority: timelockAuthority.publicKey,
                })
                .signers([timelockAuthority])
                .rpc();

            console.log("Successfully queued support token operation:", tx);

            // Get the state to find the operation index
            const state = await fetchStateAccount(program, statePda);
            const operationIndex = state.pendingOperations.findIndex(op => op.operationType === 1);

            // Wait for the timelock delay
            await waitForTimelock(state);

            // Execute the operation
            const execTx = await program.methods
                .executeOperation(new BN(operationIndex))
                .accounts({
                    state: statePda,
                    authority: timelockAuthority.publicKey,
                    tokenMint: newToken,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([timelockAuthority])
                .rpc();

            console.log("Successfully executed support token operation:", execTx);

            // Verify the token was added to supported tokens
            const stateAfterExecution = await fetchStateAccount(program, statePda);
            const tokenSupported = stateAfterExecution.supportedTokens.some(
                token => token.toString() === newToken.toString()
            );
            expect(tokenSupported).to.be.true;

            // Verify the min deposit was set correctly
            const minDeposit = stateAfterExecution.minDeposits.find(
                deposit => deposit.token.toString() === newToken.toString()
            );
            expect(minDeposit).to.not.be.undefined;
            expect(minDeposit?.amount.toString()).to.equal(minDepositAmount.toString());
        } catch (e) {
            console.error("Error supporting new token:", e);
            throw e;
        }
    });
}); 